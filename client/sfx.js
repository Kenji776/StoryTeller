// === SfxManager ===
// Plays one-shot sound effects received from the server via the sfx:play
// socket event.  Effects are layered (multiple can play at once) and each
// gets its own Audio element that is disposed after playback ends.

class SfxManager {
	constructor() {
		this.muted  = false;
		this.volume = 0.5;   // default SFX volume (independent of music)
		this._bindControls();
	}

	// Play one or more effects.  `effects` is an array of { file, name }.
	play(effects) {
		if (!Array.isArray(effects) || this.muted) return;

		for (const fx of effects) {
			if (!fx?.file) continue;
			const audio  = new Audio(`/sfx/${fx.file}`);
			audio.volume = this.volume;

			audio.play().catch(err => console.warn("🔊 SFX playback failed:", err.message));

			// Clean up after playback finishes
			audio.addEventListener("ended", () => { audio.src = ""; });
			audio.addEventListener("error", ()  => { audio.src = ""; });

			console.log(`🔊 Playing SFX: ${fx.name || fx.file}`);
		}
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
