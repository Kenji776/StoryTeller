/**
 * Provider-agnostic narration emission.
 *
 * Takes whatever frames a TTS adapter produces and broadcasts them to a lobby as
 * Socket.IO events. Nothing here knows which engine is speaking; that is the point.
 *
 * The one invariant every path below preserves: **a `narration:audio:end` is always
 * emitted.** The client answers it with `narration:done`, which is what starts the
 * turn timer. Failing to emit it does not merely lose audio, it stalls the game.
 */

import { randomUUID } from "crypto";

/**
 * Emitted event names, in the order a healthy stream produces them.
 *
 * `narration:start`     announces the stream and its playback format
 * `narration:audio`     zero or more base64 payloads
 * `narration:alignment` zero or more word-timing batches
 * `narration:audio:end` always, exactly once
 */

/**
 * Synthesises narration and streams it to every client in a lobby.
 *
 * @description Resolution of which provider and voice to use is delegated to
 *   `deps.resolve`, because that answer is per lobby and lives in lobby state. When
 *   there is nothing to say, nothing configured to say it, or dev mode is on, the
 *   function still emits a start and an end so the client transitions out of its
 *   waiting state — carrying `REJECTED_REQUEST_STATUS` on the start frame, which is
 *   how the client knows no audio is coming.
 *
 *   Note that this takes a bare `lobbyId` and applies `deps.room` itself. The
 *   previous implementation was called with an already-mapped room *and* mapped it
 *   again, which was harmless only because `room` is currently the identity
 *   function.
 * @param {object} io - Socket.IO server instance.
 * @param {string} lobbyId - Lobby identifier, unmapped.
 * @param {string} text - Narration text; bracketed stage directions are not spoken.
 * @param {string|null} voiceId - Requested voice, passed to the resolver.
 * @param {string} [playerName] - Speaker label; defaults to "DM".
 * @param {{resolve: Function, devMode: boolean, REJECTED_REQUEST_STATUS: number, room: Function, log: Function}} deps
 *   - `resolve` Receives `(lobbyId, voiceId)`, returns `{provider, providerDeps, voiceId}` or null.
 *   - `devMode` When true, emits stub events and spends nothing.
 *   - `room`    Maps a lobby id to a Socket.IO room name.
 * @returns {Promise<void>} Resolves once the stream has been fully emitted. Never rejects.
 */
export async function streamNarrationToClients(io, lobbyId, text, voiceId, playerName, deps) {
	const { devMode, REJECTED_REQUEST_STATUS, room, log } = deps;
	const streamId = randomUUID();
	const target = room(lobbyId);
	const speaker = playerName || "DM";

	/**
	 * Announces a stream that will carry no audio and closes it immediately.
	 *
	 * @description Deliberately emits no `narration` frame: every caller has already
	 *   broadcast the prose, and a second frame with `content: null` makes the game
	 *   client print an empty "DM:" line and the admin feed stringify it to "null".
	 * @param {string} why - Reason, logged rather than sent.
	 * @returns {void}
	 */
	const emitSilence = (why) => {
		log?.(`🔇 No narration audio for lobby ${lobbyId}: ${why}`);
		io.to(target).emit("narration:start", { speaker, streamId, status: REJECTED_REQUEST_STATUS });
		io.to(target).emit("narration:audio:end", { streamId, status: REJECTED_REQUEST_STATUS });
	};

	if (devMode) return emitSilence("developer mode");

	// Both adapters strip bracketed stage directions, so text consisting only of
	// them would produce a request for silence.
	if (!String(text ?? "").replace(/\[[^\]]*\]/g, " ").trim()) return emitSilence("nothing to speak");

	let resolved;
	try {
		resolved = deps.resolve(lobbyId, voiceId);
	} catch (err) {
		return emitSilence(`provider resolution failed: ${err.message}`);
	}
	if (!resolved?.provider) return emitSilence("no TTS provider is configured or available");

	const { provider, providerDeps, voiceId: resolvedVoice } = resolved;

	io.to(target).emit("narration:start", { speaker, streamId, format: provider.audioFormat });

	try {
		for await (const frame of provider.synthesize(text, resolvedVoice, providerDeps)) {
			if (frame?.type === "audio") {
				io.to(target).emit("narration:audio", { streamId, data: frame.data.toString("base64") });
			} else if (frame?.type === "alignment") {
				io.to(target).emit("narration:alignment", { streamId, words: frame.words });
			}
			// Anything else is a provider extending the protocol; ignore it rather
			// than failing a narration over a frame we do not need.
		}
	} catch (err) {
		// Audio already delivered is still worth playing, so this does not retract
		// anything — it just closes the stream so the game can move on.
		log?.(`💥 TTS streaming failed for lobby ${lobbyId} via ${provider.id}: ${err.message}`);
	}

	io.to(target).emit("narration:audio:end", { streamId });
}
