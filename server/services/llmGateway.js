/**
 * The gateway every model call in the game goes through.
 *
 * It exists to keep one signature — `getLLMResponse(messages, {provider, model,
 * lobbyId})` — while everything behind it changes. Roughly twenty call sites
 * across `server.js`, the turn timer, the DM-JSON repair passes, the action gate
 * and the newbie advisor share that shape, and rewriting them all to handle a
 * new failure contract would be a much larger and riskier change than replacing
 * what sits underneath.
 *
 * So the contract is preserved deliberately, warts included: a failure comes back
 * as a *string* that `llmFailure.js` recognises, rather than as an exception.
 * ADR 0009 already records that returning sentinels is the design fault; this
 * change does not fix it, and would have had to touch every caller to try.
 *
 * What it does add is a second, structured channel. `onFailure` receives the real
 * error — its reason, its kind, whether it is retryable — so the server can raise
 * an incident and tell the host what to fix, which a sentinel string travelling
 * up the narration path never could.
 */

import path from "path";
import { PORTRAIT_SCENE } from "../../client/portraitPrompt.js";
import fsDefault from "fs";

import { redactLLMConfig } from "./llm/config.js";
import { CredentialRequiredError } from "./credentials/resolve.js";
import { characterPlan, sceneFor } from "./images/characterRecords.js";

/**
 * Marks a reply that is a failure rather than narration.
 *
 * `llmFailure.js` matches on this, and the two must stay in step — a sentinel
 * the guard does not recognise would be published to players as story.
 */
export const AI_UNAVAILABLE_PREFIX = "[AI unavailable]";

/**
 * Provider ids that changed name, and what they are now.
 *
 * Lobbies persisted before `services/llm/` existed carry `llmProvider: "claude"`,
 * which no registry knows. Aliasing beats rewriting every lobby file on disk: it
 * is reversible, it cannot corrupt anything, and a lobby that has not been opened
 * in months still works the first time someone does.
 */
const PROVIDER_ALIASES = Object.freeze({ claude: "anthropic" });

/** Image providers are tried in this order when a lobby names none. */
const IMAGE_FALLBACK_ORDER = Object.freeze(["local-image", "openai"]);

/**
 * @description Resolves a stored provider id to the one the registry uses.
 * @param {*} id - The provider id from lobby settings.
 * @returns {string} The canonical id.
 */
function canonicalProviderId(id) {
	const raw = typeof id === "string" ? id.trim().toLowerCase() : "";
	return PROVIDER_ALIASES[raw] ?? raw;
}

/**
 * @description Reports whether the prompt is asking for JSON, which some adapters
 *   can enforce at the API level. Preserved from the previous service: the DM
 *   prompt says so in prose, and there is no other signal.
 * @param {Array<object>} messages - The conversation.
 * @returns {boolean} True when a JSON reply is wanted.
 */
function wantsJson(messages) {
	return (messages || []).some((m) => typeof m?.content === "string" && m.content.toLowerCase().includes("json"));
}

/**
 * Creates the gateway.
 *
 * @param {object} options - Injected collaborators.
 * @param {object} options.credentials - The assembled credential system.
 * @param {object} [options.fsImpl=fs] - Filesystem, for the call journal.
 * @param {string} options.logDir - Where the journal is written.
 * @param {Function} [options.fetchImpl] - Fetch handed to the adapters.
 * @param {Function} [options.log] - Logger.
 * @param {Function} [options.now] - Clock returning a Date.
 * @param {Function} [options.onFailure] - Receives structured failures, so the
 *   server can pause a lobby and tell its host what is wrong.
 * @returns {{getLLMResponse: Function, generateImage: Function}} The gateway.
 */
export function createLLMGateway({
	credentials,
	fsImpl = fsDefault,
	logDir,
	fetchImpl,
	log = () => {},
	now = () => new Date(),
	onFailure = () => {},
} = {}) {
	try {
		fsImpl.mkdirSync(logDir, { recursive: true });
	} catch {
		// A missing log directory must not stop the game starting.
	}

	/**
	 * @description Appends one entry to the lobby's call journal. Never throws: a
	 *   journal is diagnostics, and losing a line is not worth losing a turn.
	 * @param {object} entry - The entry to record.
	 * @returns {void}
	 */
	function journal(entry) {
		try {
			const name = entry.lobbyId ? `llm-${entry.lobbyId}.jsonl` : `llm-${now().toISOString().slice(0, 10)}.jsonl`;
			fsImpl.appendFileSync(path.join(logDir, name), `${JSON.stringify(entry)}\n`);
		} catch (err) {
			log(`⚠️ Failed to write the LLM journal: ${err.message}`);
		}
	}

	/**
	 * @description Turns a failure into the sentinel string callers expect, and
	 *   reports it structurally at the same time.
	 * @param {object} detail - What went wrong.
	 * @returns {string} The sentinel reply.
	 */
	function fail(detail) {
		onFailure(detail);
		log(`💥 AI unavailable for lobby ${detail.lobbyId ?? "—"}: ${detail.message}`);
		return `${AI_UNAVAILABLE_PREFIX} ${detail.message}`;
	}

	/**
	 * @description Resolves an image credential, trying the configured providers in
	 *   order when the caller names none. Shared by every image entry point so the
	 *   fallback order cannot drift between them.
	 * @param {string} lobbyId - Whose credential pays.
	 * @param {string} [provider] - A specific provider to use.
	 * @returns {{source: string, config: object, providerLabel: string}} The resolution.
	 * @throws {Error} When no image provider is available.
	 */
	function resolveImage(lobbyId, provider) {
		const candidates = provider ? [canonicalProviderId(provider)] : IMAGE_FALLBACK_ORDER;
		const refusals = [];
		for (const providerId of candidates) {
			try {
				return credentials.resolver.resolve({ lobbyId, capability: "image", providerId, model: null });
			} catch (err) {
				if (!(err instanceof CredentialRequiredError)) throw err;
				refusals.push(err.userMessage());
			}
		}
		throw new Error(`Image generation is unavailable. ${refusals.join(" ")}`.trim());
	}

	return {
		/**
		 * Runs one model call for a lobby.
		 *
		 * @description Never throws. Every failure — no credential, a rejected key,
		 *   an unreachable provider, an unknown provider — comes back as a string
		 *   `llmFailure.isLLMFailure` recognises, because that is the contract every
		 *   existing call site is written against.
		 * @param {Array<object>} messages - The conversation.
		 * @param {object} [options] - Call options.
		 * @param {string} [options.provider] - The lobby's provider id.
		 * @param {string} [options.model] - The lobby's model.
		 * @param {string} [options.lobbyId] - Whose credential pays, and where to journal.
		 * @param {AbortSignal} [options.signal] - Cancellation signal.
		 * @returns {Promise<string>} The reply, or a recognised failure sentinel.
		 */
		async getLLMResponse(messages, { provider, model, lobbyId, signal } = {}) {
			const providerId = canonicalProviderId(provider);
			const startedAt = Date.now();

			let resolved;
			try {
				resolved = credentials.resolver.resolve({ lobbyId, capability: "chat", providerId, model: model ?? null });
			} catch (err) {
				if (!(err instanceof CredentialRequiredError)) throw err;
				const message = err.userMessage();
				journal({ ts: now().toISOString(), lobbyId: lobbyId ?? null, provider: providerId, model: model ?? null, error: message });
				return fail({ lobbyId, capability: "chat", providerId, reason: err.reason, message, retryable: false });
			}

			const adapter = credentials.providerFor("chat", resolved.config.providerId);
			if (!adapter?.chat) {
				const message = `No chat adapter is registered for "${resolved.config.providerId}".`;
				return fail({ lobbyId, capability: "chat", providerId, reason: "unknown_provider", message, retryable: false });
			}

			try {
				const result = await adapter.chat({
					messages,
					config: resolved.config,
					model: resolved.config.model,
					json: wantsJson(messages),
					signal,
					fetchImpl,
				});

				journal({
					ts: now().toISOString(),
					lobbyId: lobbyId ?? null,
					provider: resolved.config.providerId,
					model: result.model ?? resolved.config.model ?? null,
					source: resolved.source,
					config: redactLLMConfig(resolved.config),
					durationMs: Date.now() - startedAt,
					messages,
					response: result.text ?? null,
					usage: result.usage ?? null,
				});

				return result.text ?? "";
			} catch (err) {
				// `userMessage` scrubs token-shaped substrings; provider error bodies
				// occasionally echo the submitted key back, and this text reaches a screen.
				const message = typeof err?.userMessage === "function" ? err.userMessage() : err?.message ?? String(err);
				journal({
					ts: now().toISOString(),
					lobbyId: lobbyId ?? null,
					provider: resolved.config.providerId,
					model: resolved.config.model ?? null,
					source: resolved.source,
					config: redactLLMConfig(resolved.config),
					durationMs: Date.now() - startedAt,
					messages,
					response: null,
					error: message,
				});

				return fail({
					lobbyId,
					capability: "chat",
					providerId: resolved.config.providerId,
					reason: err?.kind ?? "unknown",
					kind: err?.kind ?? "unknown",
					retryable: Boolean(err?.retryable),
					message,
				});
			}
		},

		/**
		 * Draws a player, keeping their face the same as last time.
		 *
		 * @description The whole point of the character API: a stored likeness is
		 *   posed rather than re-invented, so the same hero looks like themselves in
		 *   every image. `characterPlan` decides whether the likeness they have still
		 *   applies; a permanent change mints a new one and retires the old.
		 *
		 *   Providers without a character API — OpenAI's, today — fall through to a
		 *   plain generation. The portrait still appears; it simply carries no promise
		 *   of continuity, and `characterId` comes back null so the caller stores
		 *   nothing it cannot use.
		 * @param {object} request - Who to draw.
		 * @param {string} request.lobbyId - Whose credential pays.
		 * @param {object} request.record - The player's stored record.
		 * @param {string} request.name - The character's name.
		 * @param {string} request.appearance - What is permanently true of them.
		 * @param {string} [request.provider] - A specific image provider.
		 * @param {boolean} [request.force=false] - Rebuild the likeness regardless.
		 * @param {{width: number, height: number}} [request.size] - Image dimensions.
		 * @param {AbortSignal} [request.signal] - Cancellation signal.
		 * @returns {Promise<{b64: string, model: string|null, characterId: string|null,
		 *   appearance: string, created: boolean}>} The portrait and the identity to store.
		 * @throws {Error} When no image provider is available, or generation failed.
		 */
		async ensureCharacterImage({ lobbyId, record, name, appearance, portraitPrompt, portraitScene = PORTRAIT_SCENE, provider, force = false, size, signal } = {}) {
			const resolved = resolveImage(lobbyId, provider);
			const adapter = credentials.providerFor("image", resolved.config.providerId);

			// What the player is shown. Drawn from the prompt rather than from the
			// stored likeness: rendering it from the likeness reproduced that
			// likeness's framing, and the reference the image server draws is a neutral
			// front-facing bust — right for matching a face in a later scene, and
			// exactly the driving-licence photo this is meant to stop being.
			//
			// The likeness is still created and still drives scene illustrations, so
			// faces stay consistent in play. Only the portrait is free.
			const drawing = String(portraitPrompt || "").trim() || `${appearance} ${portraitScene}`.trim();

			/**
			 * @description Renders the player-facing portrait from the prompt.
			 * @returns {Promise<object>} The image.
			 */
			const drawPortrait = () => adapter.generate({ prompt: drawing, config: resolved.config, size, signal, fetchImpl });

			if (!adapter?.createCharacter) {
				// No continuity here, but a portrait is still better than a refusal.
				const image = await drawPortrait();
				return { ...image, characterId: null, appearance, created: false };
			}

			const plan = characterPlan({ record, appearance, force });

			if (plan.action === "reuse") {
				const image = await drawPortrait();
				return { ...image, characterId: plan.characterId, appearance, created: false };
			}

			const character = await adapter.createCharacter({ name, appearance, config: resolved.config, signal, fetchImpl });

			if (plan.retire) {
				// Best effort. The new likeness already exists, and failing the portrait
				// because an old record would not delete would be the wrong trade.
				try {
					await adapter.deleteCharacter({ characterId: plan.retire, config: resolved.config, fetchImpl });
					log(`🎭 Retired the previous likeness ${plan.retire} for ${name}`);
				} catch (err) {
					log(`⚠️ Could not retire the previous likeness ${plan.retire}: ${err.message}`);
				}
			}

			log(`🎭 Stored a likeness for ${name} as ${character.id}`);

			// The reference the image server draws when a likeness is created is neutral
			// and front-on. It stays that way — it is what future scenes match against —
			// and the picture the player sees is drawn separately from the prompt.
			const posed = await drawPortrait().catch((err) => {
				// The likeness exists and is stored either way. A portrait that fell back
				// to the reference beats failing after paying for the character.
				log(`⚠️ Could not pose the new portrait for ${name}: ${err.message}`);
				return null;
			});

			return {
				b64: posed?.b64 ?? character.b64,
				model: posed?.model ?? null,
				characterId: character.id,
				appearance,
				created: true,
			};
		},

		/**
		 * Draws a stored character in a new moment.
		 *
		 * @description This is what makes "the party, triumphant after the battle"
		 *   possible with the right faces. Only the moment travels: the server
		 *   prepends the appearance it stored, and `sceneFor` strips the character's
		 *   own name rather than letting it read as a second person in the frame.
		 * @param {object} request - What is happening.
		 * @param {string} request.lobbyId - Whose credential pays.
		 * @param {string} request.characterId - The stored likeness.
		 * @param {string} request.moment - What they are doing.
		 * @param {string} [request.mood] - How it should feel.
		 * @param {string} [request.name] - Their name, removed from the scene.
		 * @param {string} [request.provider] - A specific image provider.
		 * @param {{width: number, height: number}} [request.size] - Image dimensions.
		 * @param {AbortSignal} [request.signal] - Cancellation signal.
		 * @returns {Promise<{b64: string, model: string|null, seed: number|null}>} The image.
		 * @throws {Error} When the provider cannot pose characters, or generation failed.
		 */
		async generateCharacterScene({ lobbyId, characterId, moment, mood, name, provider, size, signal } = {}) {
			const resolved = resolveImage(lobbyId, provider);
			const adapter = credentials.providerFor("image", resolved.config.providerId);

			if (!adapter?.generateForCharacter) {
				throw new Error(
					`${resolved.providerLabel} does not support character continuity, so it cannot draw a scene for a stored character.`,
				);
			}

			return adapter.generateForCharacter({
				characterId,
				scene: sceneFor({ moment, mood, name }),
				config: resolved.config,
				size,
				signal,
				fetchImpl,
			});
		},

		/**
		 * Generates one image for a lobby.
		 *
		 * @description Unlike `getLLMResponse` this **throws**, because its only
		 *   caller is an HTTP route that already turns an exception into a status
		 *   code. There is no narration path for an image, so there is nothing a
		 *   sentinel string would protect.
		 *
		 *   With no provider named, the configured ones are tried in order: the local
		 *   server first, because it costs nothing.
		 * @param {object} request - What to draw.
		 * @param {string} request.prompt - The finalised prompt.
		 * @param {string} request.lobbyId - Whose credential pays.
		 * @param {string} [request.provider] - A specific provider to use.
		 * @param {{width: number, height: number}} [request.size] - Requested size.
		 * @param {AbortSignal} [request.signal] - Cancellation signal.
		 * @returns {Promise<{b64: string, model: string}>} The image.
		 * @throws {Error} When no image provider is available, or generation failed.
		 */
		async generateImage({ prompt, lobbyId, provider, size, signal } = {}) {
			const resolved = resolveImage(lobbyId, provider);
			const adapter = credentials.providerFor("image", resolved.config.providerId);
			if (!adapter?.generate) {
				throw new Error(`No image adapter is registered for "${resolved.config.providerId}".`);
			}

			const result = await adapter.generate({ prompt, config: resolved.config, size, signal, fetchImpl });
			log(`🎨 Generated an image with ${resolved.config.providerId}/${result.model} (${resolved.source})`);
			return result;
		},
	};
}
