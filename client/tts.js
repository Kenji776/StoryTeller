// === Narration Stream Control (manual stop + interruption + fade-out + stream cancel) ===
let mediaSource = null;
let audioElement = null;
let sourceBuffer = null;
let queuedChunks = [];
let isNarrating = false;
let narrationCancelled = false;
let activeStreamId = null;
let audioQueue = [];

function initAudioStream() {
	try {
		// Clean up any existing stream
		if (mediaSource) {
			try {
				if (mediaSource.readyState === "open") {
					mediaSource.endOfStream();
				}
			} catch (e) {}
		}

		if (audioElement) {
			audioElement.pause();
			audioElement.src = "";
		}

		queuedChunks = [];
		sourceBuffer = null; // Reset

		// Create new MediaSource
		mediaSource = new MediaSource();
		audioElement = new Audio();
		audioElement.src = URL.createObjectURL(mediaSource);

		mediaSource.addEventListener("sourceopen", () => {
			console.log(`🔓 MediaSource sourceopen fired. readyState: ${mediaSource.readyState}`);

			if (mediaSource.readyState !== "open") {
				console.error("❌ MediaSource not open despite sourceopen event");
				return;
			}

			try {
				sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
				console.log("✅ SourceBuffer created successfully");

				// CRITICAL: Process queued chunks when buffer is ready
				sourceBuffer.addEventListener("updateend", () => {
					console.log(`📤 updateend - queued: ${queuedChunks.length}, updating: ${sourceBuffer.updating}`);

					if (narrationCancelled) {
						return;
					}

					// Process next queued chunk
					if (queuedChunks.length > 0 && !sourceBuffer.updating) {
						const nextChunk = queuedChunks.shift();
						try {
							sourceBuffer.appendBuffer(nextChunk);
							console.log(`📥 Appended queued chunk (${nextChunk.length} bytes). ${queuedChunks.length} remaining`);
						} catch (err) {
							console.error("❌ Error appending queued chunk:", err);
						}
					}

					// Start playback once we have enough buffered
					if (audioElement.paused && audioElement.buffered.length > 0) {
						const buffered = audioElement.buffered.end(0) - audioElement.currentTime;
						console.log(`🔊 Buffered: ${buffered.toFixed(2)}s, currentTime: ${audioElement.currentTime.toFixed(2)}s`);

						if (buffered > 0.5) {
							console.log("▶️ Attempting to play...");
							audioElement
								.play()
								.then(() => console.log("✅ Playback started"))
								.catch((err) => console.error("❌ Play failed:", err));
						}
					}
				});

				sourceBuffer.addEventListener("error", (e) => {
					console.error("💥 SourceBuffer error:", e);
				});

				// Process any chunks that arrived before sourceBuffer was ready
				if (queuedChunks.length > 0) {
					console.log(`🔄 Processing ${queuedChunks.length} chunks that arrived early`);
					const firstChunk = queuedChunks.shift();
					try {
						sourceBuffer.appendBuffer(firstChunk);
						console.log(`✅ Appended first queued chunk (${firstChunk.length} bytes)`);
					} catch (err) {
						console.error("❌ Failed to append first chunk:", err);
					}
				}
			} catch (err) {
				console.error("💥 Failed to create SourceBuffer:", err);
			}
		});

		mediaSource.addEventListener("error", (e) => {
			//console.error("💥 MediaSource error:", e);
		});

		audioElement.addEventListener("error", (e) => {
			console.error("💥 Audio element error:");
			console.error(e);
		});

		audioElement.addEventListener("ended", () => {
			console.log("🎵 Audio playback ended");
			showNarratorIndicator(false);
			isNarrating = false;
		});

		// canplay fires after endOfStream() so short narrations that never buffered
		// 0.5 s will still play once all data has arrived
		audioElement.addEventListener("canplay", () => {
			if (audioElement.paused && !narrationCancelled) {
				console.log("▶️ canplay — attempting play");
				audioElement.play().catch((err) => console.error("❌ canplay play failed:", err));
			}
		});

		audioElement.addEventListener("playing", () => {
			//console.log("🎵 Audio started playing");
		});

		audioElement.addEventListener("waiting", () => {
			//console.log("⏸️ Audio waiting for data");
		});

		console.log("🎬 MediaSource initialized, waiting for sourceopen...");
	} catch (err) {
		console.error("💥 initAudioStream failed:", err);
	}
}

/** Smooth fade-out before stopping playback */
async function fadeOutAndStop() {
	if (!audioElement) return;
	const fadeSteps = 10;
	const stepDuration = 30; // ms
	const initialVolume = audioElement.volume || 1.0;

	for (let i = fadeSteps; i >= 0; i--) {
		audioElement.volume = (i / fadeSteps) * initialVolume;
		await new Promise((r) => setTimeout(r, stepDuration));
	}

	try {
		audioElement.pause();
		audioElement.src = "";
	} catch {}
	audioElement.volume = initialVolume;
}

async function stopNarration() {
	console.log("🛑 stopNarration called");
	narrationCancelled = true;

	if (isNarrating && audioElement) {
		await fadeOutAndStop();
	}

	try {
		if (mediaSource && mediaSource.readyState === "open") {
			mediaSource.endOfStream();
		}
	} catch (err) {
		console.warn("MediaSource endOfStream failed:", err);
	}

	// Cleanup - FIXED: Remove error listener before clearing src
	try {
		if (audioElement) {
			// Remove error listener to prevent "Empty src" error
			audioElement.onerror = null;
			audioElement.pause();
			audioElement.src = "";
			audioElement.load(); // Important: call load() after clearing src
			audioElement.remove();
		}
	} catch (err) {
		console.warn("Audio cleanup failed:", err);
	}

	queuedChunks = [];
	isNarrating = false;
	sourceBuffer = null;
	mediaSource = null;
	audioElement = null;
	// Only hide the indicator if narration hasn't already been restarted
	// (a new narration:start can set isNarrating=true before this async cleanup finishes)
	if (!isNarrating) {
		showNarratorIndicator(false);
	}
}

stopNarrationBtn.addEventListener("click", stopNarration);
