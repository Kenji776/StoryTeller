// === SfxManager ===
// Plays one-shot sound effects received from the server via the sfx:play
// socket event.  Effects play in series (queued) with a configurable gap
// between them so they don't overlap.

const SFX_GAP_MS = 1500; // pause between consecutive effects

class SfxManager {
	constructor() {
		this.muted  = false;
		this.volume = 0.5;   // default SFX volume (independent of music)
		this._queue = [];    // pending effects: { file, name }
		this._playing = false;
		this._bindControls();
	}

	// Enqueue one or more effects to play in series.
	play(effects) {
		if (!Array.isArray(effects) || this.muted) return;
		for (const fx of effects) {
			if (!fx?.file) continue;
			this._queue.push(fx);
		}
		this._pump();
	}

	// Process the next effect in the queue.
	_pump() {
		if (this._playing || this._queue.length === 0) return;
		this._playing = true;

		const fx    = this._queue.shift();
		const audio = new Audio(`/sfx/${fx.file}`);
		audio.volume = this.volume;

		console.log(`🔊 Playing SFX: ${fx.name || fx.file}`);

		const next = () => {
			audio.src = "";
			this._playing = false;
			if (this._queue.length > 0) {
				setTimeout(() => this._pump(), SFX_GAP_MS);
			}
		};

		audio.addEventListener("ended", next);
		audio.addEventListener("error", next);

		audio.play().catch(err => {
			console.warn("🔊 SFX playback failed:", err.message);
			next();
		});
	}

	toggleMute() {
		this.muted = !this.muted;
		return this.muted;
	}

	setVolume(v) {
		this.volume = Math.max(0, Math.min(1, v));
	}

	_bindControls() {
		document.addEventListener("DOMContentLoaded", () => {
			const muteBtn = document.getElementById("sfxMuteBtn");
			const slider  = document.getElementById("sfxVolumeSlider");

			if (muteBtn) muteBtn.addEventListener("click", () => {
				this.toggleMute();
				muteBtn.textContent = this.muted ? "🔇" : "🔊";
			});

			if (slider) {
				slider.addEventListener("input", () => {
					this.muted = false;
					this.setVolume(slider.value / 100);
					if (muteBtn) muteBtn.textContent = "🔊";
				});
			}
		});
	}
}

window.sfxManager = new SfxManager();
