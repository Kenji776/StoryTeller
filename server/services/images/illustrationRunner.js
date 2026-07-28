/**
 * Turning the DM's request for a picture into one.
 *
 * The turn must not wait for this. Generation takes seven seconds warm and up to
 * twenty cold, and a story beat that stalls for twenty seconds is a worse
 * experience than one with no picture. So the placeholder is announced first,
 * the work happens after, and the finished image is matched to the placeholder
 * by id.
 *
 * **Nothing here may throw into the turn.** Every path is wrapped: an image is a
 * garnish, and losing the narration because a GPU was busy would be absurd. A
 * failure is announced rather than swallowed, so a placeholder always resolves
 * to something — a picture or an apology, never a permanent spinner.
 */

import { parseIllustration, illustrationGate } from "./illustration.js";

/**
 * The moment every adventure opens on.
 *
 * Fixed rather than model-authored: this one is not the Dungeon Master's to
 * decline, so there is nothing for it to decide. Phrased as a scene — what is
 * happening — for the same reason every other scene is: the stored appearance is
 * prepended by the server, and restating any of it here makes faces drift.
 */
const OPENING_MOMENT = "setting out on the road at first light, pack shouldered, open country ahead, "
	+ "full body, wide shot";
const OPENING_MOOD = "expectant";
const OPENING_CAPTION = "The adventure begins";

/**
 * How hard the stored likeness pulls when drawing a scene.
 *
 * The default of 1.0 is right for a portrait, where the face is the subject. For
 * a scene it is wrong, and visibly so: the first live run produced three studio
 * portraits against a grey background for a moment that read "setting out on
 * their adventure" — the reference image simply overwhelmed the scene. The API's
 * own guidance is to lower it toward 0.8 when the pose comes out stiff.
 */
const SCENE_IDENTITY_STRENGTH = 0.85;

/** Portrait, matching what the character adapter draws by default. */
const SCENE_SIZE = Object.freeze({ width: 896, height: 1152 });

/** Prefixes that mark a string as a credential regardless of how short it is. */
const CREDENTIAL_PREFIXES = /(sk-[A-Za-z0-9-]+|ghp_\S+|github_pat_\S+|xoxb-\S+|AKIA\S+)/g;

/**
 * @description Removes credentials from an error before it reaches a screen or a
 *   log. Provider bodies occasionally echo a submitted key back.
 *
 *   Two rules rather than one length threshold. A blunt threshold set low enough
 *   to catch a short token also ate ordinary identifiers: a real wiring bug once
 *   surfaced as three lines of "*** is not a function", scrubbing the very name
 *   that would have identified it. So known credential prefixes are matched
 *   explicitly, and the length rule is set high enough that
 *   `gateway.ensureCharacterImage` (28) survives while a real key does not: every
 *   credential this system handles is either prefixed or at least 32 characters.
 * @param {*} err - Whatever was thrown.
 * @returns {string} A message safe to show and useful to read.
 */
function safeMessage(err) {
	const text = typeof err?.userMessage === "function" ? err.userMessage() : err?.message ?? String(err);
	// A literal regex, not a constructed one: `\S` inside a template literal is
	// just `S`, and the constructed version was quietly matching runs of the
	// letter S instead of long tokens.
	return String(text)
		.replace(CREDENTIAL_PREFIXES, "***")
		.replace(/\S{32,}/g, "***");
}

/**
 * Creates the runner.
 *
 * @param {object} options - Injected collaborators.
 * @param {object} options.gateway - Carries `generateCharacterScene` and `generateImage`.
 * @param {Function} options.partyOf - `(lobbyId)` → players with `name` and `imageCharacterId`.
 * @param {Function} options.settingsOf - `(lobbyId)` → `{illustrationMode, lastIllustrationAt}`.
 * @param {Function} options.markIllustrated - `(lobbyId, at)` records the cooldown.
 * @param {Function} options.saveImage - `(name, b64)` → the url it can be served from.
 * @param {Function} options.emit - `(lobbyId, event, payload)`.
 * @param {Function} [options.appearanceOf] - `(player)` → what is permanently
 *   true of them, for a party member who has no likeness yet.
 * @param {Function} [options.onCharacterCreated] - `(lobbyId, name, result)`,
 *   so a likeness made for the opening is stored rather than lost.
 * @param {Function} [options.now] - Clock returning epoch milliseconds.
 * @param {Function} [options.log] - Logger.
 * @returns {{consider: Function}} The runner.
 */
export function createIllustrationRunner({
	gateway,
	partyOf,
	settingsOf,
	markIllustrated,
	saveImage,
	emit,
	appearanceOf = (player) => player?.imageAppearance ?? player?.name ?? "an adventurer",
	onCharacterCreated = () => {},
	now = () => Date.now(),
	log = () => {},
}) {
	/**
	 * Lobbies with an illustration still being drawn.
	 *
	 * The image server works on one request at a time. With no time cooldown, a
	 * fast sequence of turns would queue images faster than they can be drawn, and
	 * the last would arrive minutes after the moment it illustrates. Refusing while
	 * one is in flight is a truer limit than any interval, because it measures what
	 * is actually happening rather than guessing at it.
	 */
	const drawing = new Set();

	/**
	 * @description Draws one character from their stored likeness.
	 * @param {string} lobbyId - The lobby.
	 * @param {object} directive - The parsed directive.
	 * @param {object} player - The character to draw.
	 * @returns {Promise<object|null>} `{name, url}`, or null when it failed.
	 */
	async function drawCharacter(lobbyId, directive, player) {
		const image = await gateway.generateCharacterScene({
			lobbyId,
			characterId: player.imageCharacterId,
			moment: directive.moment,
			mood: directive.mood,
			name: player.name,
			size: SCENE_SIZE,
			identityStrength: SCENE_IDENTITY_STRENGTH,
		});
		const url = await saveImage(`${lobbyId}-${String(player.name).replace(/[^a-zA-Z0-9]/g, "_")}-${now()}`, image.b64);
		return { name: player.name, url };
	}

	/**
	 * @description Draws a place, item or creature with no likeness involved.
	 * @param {string} lobbyId - The lobby.
	 * @param {object} directive - The parsed directive.
	 * @returns {Promise<object|null>} `{name, url}`, or null when it failed.
	 */
	async function drawScene(lobbyId, directive) {
		const prompt = directive.mood ? `${directive.prompt}, ${directive.mood}` : directive.prompt;
		const image = await gateway.generateImage({ lobbyId, prompt, size: SCENE_SIZE });
		const url = await saveImage(`${lobbyId}-scene-${now()}`, image.b64);
		return { name: null, url };
	}

	return {
		/**
		 * Draws the party as their adventure opens.
		 *
		 * @description Not a directive and not the DM's to decline — a game starting
		 *   always gets this picture. It therefore ignores the cooldown, which exists
		 *   to pace the DM's own enthusiasm and has nothing to say about an event that
		 *   happens once per game.
		 *
		 *   It does still respect `off`. That is the host's explicit choice, and
		 *   overriding it would make the one setting in the game that does not mean
		 *   what it says.
		 *
		 *   A party member with no likeness yet has one made first, so nobody is left
		 *   out of the opening picture for not having clicked "generate portrait".
		 * @param {string} lobbyId - The lobby whose game is starting.
		 * @returns {Promise<object|null>} The placeholder id, or null when nothing was drawn.
		 */
		async openingScene(lobbyId) {
			let party;
			try {
				const settings = settingsOf(lobbyId) ?? {};
				if (!settings.illustrationMode || settings.illustrationMode === "off") return null;

				party = (partyOf(lobbyId) ?? []).filter((p) => p?.name);
				if (!party.length) return null;
			} catch (err) {
				log(`⚠️ Opening illustration could not be prepared: ${safeMessage(err)}`);
				return null;
			}

			if (drawing.has(lobbyId)) return null;

			const id = `ill_open_${now()}`;
			try {
				markIllustrated(lobbyId, now());
			} catch (err) {
				log(`⚠️ Could not record the illustration cooldown: ${safeMessage(err)}`);
			}

			drawing.add(lobbyId);
			emit(lobbyId, "illustration:pending", { id, caption: OPENING_CAPTION, expected: party.length });

			try {
				const images = [];
				for (const player of party) {
					try {
						let characterId = player.imageCharacterId;
						if (!characterId) {
							// Nobody is left out for not having drawn a portrait first.
							const made = await gateway.ensureCharacterImage({
								lobbyId,
								record: player,
								name: player.name,
								appearance: appearanceOf(player),
							});
							characterId = made?.characterId;
							if (made?.characterId) onCharacterCreated(lobbyId, player.name, made);
						}
						if (!characterId) continue;

						images.push(await drawCharacter(lobbyId, { moment: OPENING_MOMENT, mood: OPENING_MOOD }, { ...player, imageCharacterId: characterId }));
					} catch (err) {
						log(`⚠️ Opening illustration failed for ${player.name}: ${safeMessage(err)}`);
					}
				}

				if (!images.length) {
					emit(lobbyId, "illustration:failed", { id, error: "The opening illustration could not be drawn." });
					return { id, caption: OPENING_CAPTION, drawn: 0 };
				}

				log(`🖼️ Drew the opening scene for ${lobbyId} (${images.length}/${party.length})`);
				emit(lobbyId, "illustration:ready", { id, caption: OPENING_CAPTION, images, failures: [] });
				return { id, caption: OPENING_CAPTION, drawn: images.length };
			} catch (err) {
				emit(lobbyId, "illustration:failed", { id, error: safeMessage(err) });
				return { id, caption: OPENING_CAPTION, drawn: 0 };
			} finally {
				drawing.delete(lobbyId);
			}
		},

		/**
		 * Looks at a DM reply and draws what it asked for, if anything.
		 *
		 * @description Returns as soon as the placeholder is out; the drawing itself
		 *   is awaited here only so tests are deterministic, and the caller is
		 *   expected to *not* await this. It never rejects.
		 * @param {string} lobbyId - The lobby.
		 * @param {object} reply - The parsed DM JSON.
		 * @returns {Promise<object|null>} The placeholder id and caption, or null
		 *   when nothing was drawn.
		 */
		async consider(lobbyId, reply) {
			let directive;
			try {
				directive = parseIllustration(reply, { party: partyOf(lobbyId) });
				if (!directive) return null;

				const settings = settingsOf(lobbyId) ?? {};
				const gate = illustrationGate({
					mode: settings.illustrationMode,
					lastAt: settings.lastIllustrationAt ?? null,
					now: now(),
				});
				if (!gate.allowed) {
					// Deliberately silent. A refused illustration is a decision, not a
					// fault, and telling players about one they never expected would be
					// noise.
					log(`🖼️ Illustration skipped for ${lobbyId}: ${gate.reason}`);
					return null;
				}
			} catch (err) {
				log(`⚠️ Illustration directive could not be read: ${safeMessage(err)}`);
				return null;
			}

			if (drawing.has(lobbyId)) {
				log(`🖼️ Illustration skipped for ${lobbyId}: one is still being drawn`);
				return null;
			}

			const id = `ill_${now()}_${Math.round(now() % 100000)}`;
			const caption = directive.kind === "characters" ? directive.moment : directive.prompt;
			const targets = directive.kind === "characters" ? directive.characters : [null];

			// Marked *before* the wait. Generation takes seconds, and a second turn
			// arriving meanwhile would otherwise pass the gate and draw again.
			try {
				markIllustrated(lobbyId, now());
			} catch (err) {
				log(`⚠️ Could not record the illustration cooldown: ${safeMessage(err)}`);
			}

			drawing.add(lobbyId);
			emit(lobbyId, "illustration:pending", { id, caption, expected: targets.length });

			try {
				const images = [];
				const failures = [];
				// Sequential: the image server works on one at a time, so parallel
				// calls only queue and make a failure harder to attribute.
				for (const player of targets) {
					try {
						images.push(player ? await drawCharacter(lobbyId, directive, player) : await drawScene(lobbyId, directive));
					} catch (err) {
						const message = safeMessage(err);
						log(`⚠️ Illustration failed for ${player?.name ?? "a scene"}: ${message}`);
						failures.push({ name: player?.name ?? null, error: message });
					}
				}

				if (!images.length) {
					emit(lobbyId, "illustration:failed", { id, error: failures[0]?.error ?? "The illustration could not be drawn." });
					return { id, caption, drawn: 0 };
				}

				log(`🖼️ Illustrated "${caption.slice(0, 60)}" for ${lobbyId} (${images.length}/${targets.length})`);
				emit(lobbyId, "illustration:ready", { id, caption, images, failures });
				return { id, caption, drawn: images.length };
			} catch (err) {
				// The catch-all. A placeholder with nothing to resolve it is the one
				// outcome worth guarding against absolutely.
				emit(lobbyId, "illustration:failed", { id, error: safeMessage(err) });
				return { id, caption, drawn: 0 };
			} finally {
				// In a finally, or one failure would block the lobby from ever
				// illustrating again.
				drawing.delete(lobbyId);
			}
		},
	};
}
