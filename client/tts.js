// === Narration Stream Control ===
// Two independent audio channels (DM + Player) so they never interfere.
//
// Each channel plays one of two ways, chosen by the `format` the server announces
// on narration:start:
//
//   "mpeg"  — streamed incrementally through MediaSource as chunks arrive.
//   "wav"   — collected in full, then played as one Blob. MediaSource cannot decode
//             WAV in any browser, and the local TTS server returns a complete PCM
//             clip rather than a stream, so there is nothing to stream anyway.
//
// Everything downstream of playback — fade-out, stop, word highlighting — is shared,
// because both paths drive an ordinary HTMLAudioElement.

/** Server `format` values mapped to the MIME type a Blob needs. */
const AUDIO_MIME = { wav: "audio/wav", mpeg: "audio/mpeg" };

/** The only format the MediaSource path can handle. */
const STREAMING_FORMAT = "mpeg";

class NarrationChannel {
	constructor(name) {
		this.name = name;
		this.mediaSource = null;
		this.audio = null;
		this.sourceBuffer = null;
		this.queue = [];
		this.objectURL = null;
		this.streamId = null;
		this.active = false;
		this.cancelled = false;
		this._stopPromise = null;
		// Playback strategy
		this.format = STREAMING_FORMAT;
		this.buffered = false;
		this.blobParts = [];
		// Word-level highlight state
		this.alignmentWords = [];
		this._highlightedIdx = -1;
	}

	// ── Pipeline helpers ─────────────────────────────────────────────────────

	_pipelineReady() {
		return (
			this.mediaSource &&
			this.mediaSource.readyState === "open" &&
			this.sourceBuffer &&
			!this.sourceBuffer.updating
		);
	}

	_safeAppend(chunk) {
		try {
			if (!this.sourceBuffer || this.sourceBuffer.updating) return false;
			this.sourceBuffer.appendBuffer(chunk);
			return true;
		} catch (err) {
			console.warn(`⚠️ [${this.name}] appendBuffer failed — skipping:`, err.message);
			return false;
		}
	}

	_drainQueue() {
		if (this.cancelled || !this.sourceBuffer) return;
		while (this.queue.length > 0 && !this.sourceBuffer.updating) {
			const next = this.queue.shift();
			if (this._safeAppend(next)) return; // wait for updateend
		}
		this._tryPlay();
	}

	_tryPlay() {
		try {
			if (!this.audio || !this.audio.paused || this.cancelled) return;
			// The buffered path starts itself in _playBuffered once the clip is whole;
			// there is no partial-buffer threshold to wait for.
			if (this.buffered) return;
			if (this.audio.buffered.length === 0) return;
			const buffered = this.audio.buffered.end(0) - this.audio.currentTime;
			if (buffered > 0.3) this.audio.play().catch(() => {});
		} catch {}
	}

	// ── Teardown ─────────────────────────────────────────────────────────────

	_teardown() {
		this._clearHighlight();
		try { if (this.mediaSource && this.mediaSource.readyState === "open") this.mediaSource.endOfStream(); } catch {}
		try {
			if (this.audio) {
				this.audio.onerror = null;
				this.audio.pause();
				this.audio.removeAttribute("src");
				this.audio.load();
				this.audio.remove();
			}
		} catch {}
		if (this.objectURL) { try { URL.revokeObjectURL(this.objectURL); } catch {} this.objectURL = null; }
		this.sourceBuffer = null;
		this.mediaSource = null;
		this.audio = null;
		this.queue = [];
		this.blobParts = [];
		this.alignmentWords = [];
		this._highlightedIdx = -1;
	}

	_clearHighlight() {
		const div = window._activeNarrationDiv;
		if (!div) return;
		const active = div.querySelector(".narration-word.word-active");
		if (active) active.classList.remove("word-active");
	}

	// ── Init ─────────────────────────────────────────────────────────────────

	init(streamId, format = STREAMING_FORMAT) {
		this._teardown();
		this.streamId = streamId;
		this.queue = [];
		this.blobParts = [];
		this.sourceBuffer = null;
		this.cancelled = false;
		this.active = true;
		this.alignmentWords = [];
		this._highlightedIdx = -1;
		this.format = format || STREAMING_FORMAT;
		this.buffered = this.format !== STREAMING_FORMAT;

		this.audio = new Audio();
		this._attachAudioListeners();

		// The buffered path has no src until every chunk has arrived; finalize()
		// builds the Blob. Setting one here would only produce an empty-media error.
		if (!this.buffered) this._openMediaSource();
	}

	/**
	 * Builds the MediaSource pipeline for incrementally streamed audio.
	 *
	 * @returns {void}
	 */
	_openMediaSource() {
		this.mediaSource = new MediaSource();
		this.objectURL = URL.createObjectURL(this.mediaSource);
		this.audio.src = this.objectURL;

		const ms = this.mediaSource;
		const channel = this;

		ms.addEventListener("sourceopen", () => {
			if (channel.cancelled || ms !== channel.mediaSource || ms.readyState !== "open") return;
			try {
				channel.sourceBuffer = ms.addSourceBuffer("audio/mpeg");
				channel.sourceBuffer.addEventListener("updateend", () => channel._drainQueue());
				channel.sourceBuffer.addEventListener("error", () => {
					console.warn(`⚠️ [${channel.name}] SourceBuffer error — draining next`);
					setTimeout(() => channel._drainQueue(), 0);
				});
				channel._drainQueue();
			} catch (err) {
				console.error(`💥 [${channel.name}] SourceBuffer creation failed:`, err.message);
				channel._signalDone();
			}
		});

		ms.addEventListener("error", () => {
			console.warn(`⚠️ [${channel.name}] MediaSource error — signalling done`);
			channel._signalDone();
		});
	}

	/**
	 * Attaches the listeners both playback strategies share.
	 *
	 * @returns {void}
	 */
	_attachAudioListeners() {
		const channel = this;

		this.audio.addEventListener("error", () => {
			if (!channel.audio || channel.cancelled) return;

			if (channel.buffered) {
				// There is no second chance here: the Blob was the whole clip, so a
				// decode failure means this narration will never play. Signalling done
				// is what stops the turn timer waiting three minutes for audio that
				// is not coming.
				console.warn(`⚠️ [${channel.name}] Could not decode ${channel.format} audio — skipping narration`);
				channel._signalDone();
				return;
			}
			// Suppress errors before any data arrived — these are just the browser
			// complaining about a revoked object URL or an empty MediaSource and are
			// completely harmless.
			if (channel.sourceBuffer) {
				console.warn(`⚠️ [${channel.name}] Audio element error — continuing`);
			}
		});

		this.audio.addEventListener("ended", () => {
			console.log(`🎵 [${channel.name}] Playback ended`);
			channel._signalDone();
		});

		this.audio.addEventListener("canplay", () => channel._tryPlay());

		// Word-level highlight: on each timeupdate, find the word being spoken
		// and toggle a CSS class on the matching <span> in the narration div.
		this.audio.addEventListener("timeupdate", () => {
			if (channel.cancelled || !channel.alignmentWords.length) return;
			const narrationDiv = window._activeNarrationDiv;
			if (!narrationDiv) return;

			const t = channel.audio.currentTime;
			let activeIdx = -1;
			for (let i = 0; i < channel.alignmentWords.length; i++) {
				const w = channel.alignmentWords[i];
				if (t >= w.start && t <= w.end) { activeIdx = w.index; break; }
			}
			// If between words, keep the last highlighted word visible
			if (activeIdx === -1 && channel._highlightedIdx >= 0) {
				for (let i = 0; i < channel.alignmentWords.length; i++) {
					const w = channel.alignmentWords[i];
					if (t < w.start) { activeIdx = (i > 0) ? channel.alignmentWords[i - 1].index : -1; break; }
				}
			}

			if (activeIdx !== channel._highlightedIdx) {
				const prev = narrationDiv.querySelector(".narration-word.word-active");
				if (prev) prev.classList.remove("word-active");

				if (activeIdx >= 0) {
					const span = narrationDiv.querySelector(`[data-word-idx="${activeIdx}"]`);
					if (span) {
						span.classList.add("word-active");
						span.scrollIntoView({ block: "nearest", behavior: "smooth" });
					}
				}
				channel._highlightedIdx = activeIdx;
			}
		});
	}

	// ── Reconstruct if broken ────────────────────────────────────────────────

	_ensurePipeline() {
		if (this.cancelled) return false;
		// The buffered path holds nothing that can break mid-stream — chunks accumulate
		// in an array until finalize builds the Blob.
		if (this.buffered) return true;
		const broken = !this.mediaSource || !this.audio || this.mediaSource.readyState === "closed";
		if (!broken) return true;
		console.warn(`⚠️ [${this.name}] Pipeline broken — reconstructing`);
		const saved = this.queue.slice();
		const sid = this.streamId;
		this.init(sid, this.format);
		this.queue.push(...saved);
		return true;
	}

	// ── Public: append chunk ─────────────────────────────────────────────────

	appendChunk(chunk) {
		if (this.cancelled) return;
		if (this.buffered) { this.blobParts.push(chunk); return; }
		if (!this._ensurePipeline()) return;
		if (this._pipelineReady()) {
			if (!this._safeAppend(chunk)) this.queue.push(chunk);
		} else {
			this.queue.push(chunk);
		}
	}

	/**
	 * Assembles the collected chunks into one clip and plays it.
	 *
	 * @description Used for formats MediaSource cannot decode. Every failure path
	 *   signals done, because the turn timer is waiting on this channel and would
	 *   otherwise sit through its three-minute fallback in silence.
	 * @returns {void}
	 */
	_playBuffered() {
		// Cancelled covers the stop button and a player interrupting the DM: the
		// clip is discarded, but done is still signalled, because the streaming path
		// does the same via a torn-down MediaSource and the turn timer waits on it.
		if (this.cancelled || !this.audio || !this.blobParts.length) {
			this._signalDone();
			return;
		}

		const blob = new Blob(this.blobParts, { type: AUDIO_MIME[this.format] || AUDIO_MIME.mpeg });
		this.blobParts = [];
		this.objectURL = URL.createObjectURL(blob);
		this.audio.src = this.objectURL;

		this.audio.play().catch((err) => {
			// Usually the browser's autoplay policy: no user gesture yet on this tab.
			console.warn(`⚠️ [${this.name}] Playback refused — skipping narration:`, err.message);
			this._signalDone();
		});
	}

	// ── Public: finalize stream ──────────────────────────────────────────────

	finalize() {
		if (this.buffered) {
			this._playBuffered();
			return;
		}

		if (!this.mediaSource || this.mediaSource.readyState !== "open") {
			this._signalDone();
			return;
		}

		const channel = this;
		const close = () => {
			try { if (channel.mediaSource && channel.mediaSource.readyState === "open") channel.mediaSource.endOfStream(); } catch {}
		};

		if (this.sourceBuffer && (this.sourceBuffer.updating || this.queue.length > 0)) {
			let elapsed = 0;
			const MAX = 10_000, INT = 100;
			const tick = () => {
				if (channel.cancelled) return;
				const drained = !channel.sourceBuffer || (!channel.sourceBuffer.updating && channel.queue.length === 0);
				if (drained || elapsed >= MAX) {
					if (elapsed >= MAX) console.warn(`⚠️ [${channel.name}] finalize timed out`);
					close();
				} else { elapsed += INT; setTimeout(tick, INT); }
			};
			tick();
		} else {
			close();
		}
	}

	// ── Public: stop (with fade) ─────────────────────────────────────────────

	async stop() {
		if (this._stopPromise) { await this._stopPromise; return; }

		const doStop = async () => {
			this.cancelled = true;
			if (this.active && this.audio) await this._fadeOut();
			this._teardown();
			this.active = false;
		};

		this._stopPromise = doStop();
		try { await this._stopPromise; } finally { this._stopPromise = null; }
	}

	async _fadeOut() {
		const el = this.audio;
		if (!el) return;
		const steps = 10, ms = 30;
		const v0 = el.volume || 1.0;
		for (let i = steps; i >= 0; i--) {
			if (!this.audio || this.audio !== el) break;
			try { el.volume = (i / steps) * v0; } catch { break; }
			await new Promise(r => setTimeout(r, ms));
		}
		try { el.pause(); } catch {}
	}

	_signalDone() {
		this.active = false;
		// Only DM channel signals the server (turn timer), player channel
		// finishing doesn't need to notify the server.
		if (this.name === "DM") {
			showNarratorIndicator(false);
			document.dispatchEvent(new CustomEvent("narration:playback:ended"));
		}
	}
}

// ── Two independent channels ─────────────────────────────────────────────────

const dmChannel     = new NarrationChannel("DM");
const playerChannel = new NarrationChannel("Player");

/** Map a streamId to whichever channel owns it, or null. */
function _channelForStream(streamId) {
	if (dmChannel.streamId === streamId) return dmChannel;
	if (playerChannel.streamId === streamId) return playerChannel;
	return null;
}

// ── Public API (called from sockets.js and eventHandlers.js) ─────────────────

/**
 * Start a new narration stream on the appropriate channel.
 *
 * @param {string} speaker  - "DM", or a player name.
 * @param {string} streamId - Identifies this stream across all its frames.
 * @param {string} [format] - Audio format the server will send: "mpeg" streams
 *   through MediaSource, anything else is collected and played as one clip.
 */
function startNarration(speaker, streamId, format) {
	const isDM = (speaker === "DM");
	const channel = isDM ? dmChannel : playerChannel;

	// When a player starts speaking, stop the DM so they don't overlap
	if (!isDM && dmChannel.active) {
		dmChannel._teardown();
		dmChannel.active = false;
	}

	// If this channel already has an active stream, tear it down first
	if (channel.active) channel._teardown();
	channel.init(streamId, format);

	const label = isDM ? "🔮 Narrating..." : `🗣️ ${speaker} speaking...`;
	showNarratorIndicator(true, label);
}

/** Append an audio chunk to the channel that owns this streamId. */
function appendAudioChunk(streamId, chunk) {
	const ch = _channelForStream(streamId);
	if (ch) ch.appendChunk(chunk);
}

/** Finalize the stream on the channel that owns this streamId. */
function finalizeAudioStream(streamId) {
	const ch = _channelForStream(streamId);
	if (ch) {
		ch.finalize();
	} else {
		// Stream not found — signal done so the game isn't stuck
		document.dispatchEvent(new CustomEvent("narration:playback:ended"));
	}
}

/** Stop all narration (both channels). Used by the stop button and handleSendAction. */
async function stopNarration() {
	await Promise.all([dmChannel.stop(), playerChannel.stop()]);
	showNarratorIndicator(false);
}

/** Stop only the DM channel (used when player interrupts to submit action). */
async function stopDMNarration() {
	await dmChannel.stop();
}

/** Append word-level alignment data to the channel that owns this streamId. */
function setAlignmentData(streamId, words) {
	const ch = _channelForStream(streamId);
	if (ch && Array.isArray(words)) {
		ch.alignmentWords = ch.alignmentWords.concat(words);
	}
}

stopNarrationBtn.addEventListener("click", stopNarration);
