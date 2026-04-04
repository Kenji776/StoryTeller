// === UI Sound Effects ===
// Plays themed MP3 sound effects for UI interactions.
// Each interactive element declares a `data-sound` attribute whose value
// matches an effect "name" in /config/ui-sfx-library.json.
// Respects the SFX mute/volume controls.

const UISounds = (() => {
	let _loaded = false;

	// Preloaded Audio elements keyed by effect name (lowercased for matching)
	const _audioCache = {};

	/** Load the UI SFX library JSON and preload all audio files. */
	async function load() {
		try {
			const res = await fetch("/config/ui-sfx-library.json");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const library = await res.json();
			_loaded = true;

			for (const effect of library.effects || []) {
				const audio = new Audio(`/sfx/ui/${effect.file}`);
				audio.preload = "auto";
				_audioCache[effect.name.toLowerCase()] = audio;
			}

			console.log(`🔊 UI SFX library loaded — ${library.effects?.length ?? 0} effects`);
		} catch (err) {
			console.warn("🔊 UI SFX library unavailable:", err.message);
		}
	}

	/** Get current volume from the SFX manager (0-1), or 0 if muted. */
	function vol() {
		const mgr = window.sfxManager;
		if (mgr?.muted) return 0;
		return (mgr?.volume ?? 0.5) * 0.4; // UI sounds quieter than game SFX
	}

	// Throttle for rapid-fire sounds (sliders)
	let _lastPlay = 0;
	const THROTTLED = ["chain links slide", "magical shimmer"];

	/**
	 * Play a UI sound by effect name (case-insensitive match against library).
	 * This is the single entry point — everything goes through here.
	 */
	function play(name) {
		if (!_loaded || !name) return;
		const v = vol();
		if (!v) return;

		const key = name.toLowerCase();

		// Throttle rapid-fire sounds
		if (THROTTLED.includes(key)) {
			const now = performance.now();
			if (now - _lastPlay < 100) return;
			_lastPlay = now;
		}

		const cached = _audioCache[key];
		if (!cached) return;

		// Clone so overlapping plays don't cut each other off
		const audio = cached.cloneNode();
		audio.volume = v;
		audio.play().catch(() => {});
	}

	return { load, play, _lastHovered: null };
})();

// === Global event delegation ===
// Every interactive element should have a data-sound attribute.
// This delegation finds the nearest data-sound ancestor and plays it.

document.addEventListener("click", (e) => {
	// Skip mute/volume controls to avoid feedback loops
	if (e.target.closest("#sfxMuteBtn, #musicMuteBtn")) return;

	const soundEl = e.target.closest("[data-sound]");
	if (soundEl) {
		UISounds.play(soundEl.dataset.sound);
	}
}, true);

document.addEventListener("change", (e) => {
	const soundEl = e.target.closest("[data-sound]");
	if (soundEl) {
		UISounds.play(soundEl.dataset.sound);
	}
});

document.addEventListener("input", (e) => {
	if (e.target.type === "range") {
		const soundEl = e.target.closest("[data-sound]");
		if (soundEl) {
			UISounds.play(soundEl.dataset.sound);
		}
	}
});

// Hover sounds — disabled for now (too noisy), kept for future use
document.addEventListener("mouseover", (e) => {
	return; // disabled
	const soundEl = e.target.closest("[data-sound-hover]");
	if (soundEl && soundEl !== UISounds._lastHovered) {
		UISounds._lastHovered = soundEl;
		UISounds.play(soundEl.dataset.soundHover);
	}
});
document.addEventListener("mouseout", (e) => {
	const soundEl = e.target.closest("[data-sound-hover]");
	if (soundEl === UISounds._lastHovered) {
		UISounds._lastHovered = null;
	}
});

window.UISounds = UISounds;

// Load the library as soon as the script runs
UISounds.load();
