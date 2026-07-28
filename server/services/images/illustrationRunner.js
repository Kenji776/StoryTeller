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

/** Portrait, matching what the character adapter draws by default. */
const SCENE_SIZE = Object.freeze({ width: 896, height: 1152 });

/**
 * @description Removes token-shaped substrings from an error before it reaches a
 *   player's screen. Provider bodies occasionally echo a submitted key back.
 *
 *   Sixteen characters rather than the twenty `services/llm/errors.js` uses: the
 *   longest words in ordinary prose are around fifteen, so this still cannot eat
 *   a real sentence, and it catches shorter tokens that the looser threshold
 *   lets through. This is a last line of defence — `userMessage` has usually
 *   scrubbed already — and a last line should be the tight one.
 * @param {*} err - Whatever was thrown.
 * @returns {string} A message safe to show.
 */
function safeMessage(err) {
	const text = typeof err?.userMessage === "function" ? err.userMessage() : err?.message ?? String(err);
	return String(text).replace(/\S{16,}/g, "***");
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
						failures.push({ name: player?.name ?? null, error: safeMessage(err) });
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
