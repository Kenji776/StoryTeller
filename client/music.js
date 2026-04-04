// === MusicManager ===
// Unified music player. One widget, one set of controls.
// Plays menu music on landing/lobby, game music during gameplay.
// Songs organised as /music/game/{world}/{mood}/*.mp3 with default/ fallback.

// Mood labels loaded from /config/music_moods.json (single source of truth)
let MOOD_LABELS = {};
fetch("/config/music_moods.json")
	.then(r => r.json())
	.then(data => {
		for (const m of data.moods) MOOD_LABELS[m.id] = m.label;
		console.log(`🎵 Loaded ${Object.keys(MOOD_LABELS).length} mood labels`);
	})
	.catch(() => console.warn("🎵 Could not load music_moods.json"));

const FADE_DURATION_MS = 2500;
const FADE_STEPS       = 50;

class MusicManager {
	constructor() {
		this.currentMood    = null;
		this.currentFile    = null;
		this.currentTitle   = null;
		this.audio          = null;      // currently playing Audio element
		this.recentlyPlayed = [];        // last 3 files, to avoid instant repeats
		this.muted          = false;
		this.volume         = 0.35;      // default background volume
		this.worldType      = "default"; // current campaign world setting
		this._fadeTimer     = null;
		this._menuPlaying   = false;     // true when menu music is active
		this._fileCache     = {};        // cache: "world/mood" → [filenames]
		this._bindControls();
	}

	/** Set the campaign world type for world-specific music selection. */
	setWorldType(worldType) {
		this.worldType = worldType || "default";
	}

	// ── Game Music ────────────────────────────────────────────────────────────

	/** Called by the socket handler when the DM specifies a music mood. */
	async requestMood(mood) {
		if (mood === this.currentMood) {
			console.log(`🎵 requestMood("${mood}") — already playing this mood`);
			return;
		}

		// Stop menu music when game music takes over
		if (this._menuPlaying) this._stopMenuAudio();

		// Try world-specific folder first, fall back to default
		let files = await this._listFiles(this.worldType, mood);
		let resolvedWorld = this.worldType;

		if (!files.length && this.worldType !== "default") {
			files = await this._listFiles("default", mood);
			resolvedWorld = "default";
		}

		if (!files.length) {
			console.warn(`🎵 No songs found for mood "${mood}" (world: ${this.worldType})`);
			return;
		}

		// Pick a random file, avoiding recently played
		const fresh = files.filter(f => !this.recentlyPlayed.includes(f));
		const pool = fresh.length ? fresh : files;
		const file = pool[Math.floor(Math.random() * pool.length)];

		const title = this._titleFromFilename(file);
		const url   = `/music/game/${resolvedWorld}/${mood}/${file}`;

		console.log(`🎵 requestMood("${mood}") — playing "${title}" from ${resolvedWorld}/`);
		this.currentMood  = mood;
		this.currentFile  = file;
		this.currentTitle = title;
		this._menuPlaying = false;
		this._crossfadeTo(url);
		this._updateWidget();
	}

	stop() {
		if (!this.audio) return;
		this._fadeOut(this.audio, () => {
			this.audio        = null;
			this.currentMood  = null;
			this.currentFile  = null;
			this.currentTitle = null;
			this._updateWidget();
		});
	}

	// ── Menu Music ────────────────────────────────────────────────────────────

	/** Fetch the menu song list and play a random one. */
	async startMenuMusic() {
		if (this._menuPlaying) return;
		try {
			const res = await fetch("/api/menu-music");
			if (!res.ok) {
				console.warn("🎵 Menu music endpoint returned", res.status);
				return;
			}
			const files = await res.json();
			if (!files.length) {
				console.warn("🎵 No menu music files available from server");
				return;
			}

			const file = files[Math.floor(Math.random() * files.length)];
			const newAudio = new Audio(`/music/menu/${file}`);
			newAudio.loop   = true;
			newAudio.volume = 0;

			newAudio.play().then(() => {
				this._fadeIn(newAudio, 800);
			}).catch(err => console.warn("🎵 Menu music autoplay blocked:", err.message));

			// Crossfade from any existing audio
			const oldAudio = this.audio;
			this.audio = newAudio;
			if (oldAudio) {
				this._fadeOut(oldAudio, () => { oldAudio.pause(); oldAudio.src = ""; });
			}

			this._menuPlaying   = true;
			this.currentMood    = null;
			this.currentFile    = null;
			this.currentTitle   = "Menu Music";
			this._showWidget(true);
			this._updateWidget();
			console.log(`🎵 Menu music started: ${file}`);
		} catch (err) {
			console.warn("🎵 Could not load menu music:", err.message);
		}
	}

	/** Stop menu music (called internally when game music takes over). */
	stopMenuMusic() {
		if (!this._menuPlaying) return;
		this._stopMenuAudio();
	}

	_stopMenuAudio() {
		this._menuPlaying = false;
		// Don't stop the audio element here — requestMood will crossfade over it
	}

	// ── Volume & Mute ─────────────────────────────────────────────────────────

	toggleMute() {
		this.muted = !this.muted;
		if (this.audio) this.audio.volume = this.muted ? 0 : this.volume;
		this._updateWidget();
		return this.muted;
	}

	setVolume(v) {
		this.volume = Math.max(0, Math.min(1, v));
		if (this.audio && !this.muted) this.audio.volume = this.volume;
	}

	// ── Widget ────────────────────────────────────────────────────────────────

	/** Show/hide the audio widget container. */
	_showWidget(visible) {
		const widget = document.getElementById("audioWidget");
		if (widget) widget.classList.toggle("hidden", !visible);
	}

	/** Reveal the SFX row and divider (called when entering game mode). */
	showSfxRow() {
		const sfxRow  = document.getElementById("sfxRow");
		const divider = document.getElementById("audioDivider");
		if (sfxRow)  sfxRow.classList.remove("hidden");
		if (divider) divider.classList.remove("hidden");
	}

	_updateWidget() {
		const muteBtn = document.getElementById("musicMuteBtn");
		const titleEl = document.getElementById("musicSongTitle");
		const slider  = document.getElementById("musicVolumeSlider");

		if (titleEl) {
			if (this._menuPlaying) {
				titleEl.textContent = "Menu Music";
			} else if (this.currentMood) {
				titleEl.textContent = this.currentTitle || MOOD_LABELS[this.currentMood] || this.currentMood.replace(/_/g, " ");
			} else {
				titleEl.textContent = "No music";
			}
		}
		if (muteBtn) muteBtn.textContent = this.muted ? "🔇" : "🎵";
		if (slider && !slider.matches(":active")) slider.value = Math.round(this.muted ? 0 : this.volume * 100);
	}

	// ── Private ───────────────────────────────────────────────────────────────

	_bindControls() {
		document.addEventListener("DOMContentLoaded", () => {
			const muteBtn = document.getElementById("musicMuteBtn");
			const slider  = document.getElementById("musicVolumeSlider");

			if (muteBtn) muteBtn.addEventListener("click", () => this.toggleMute());
			if (slider) {
				slider.addEventListener("input", () => {
					this.muted = false;
					this.setVolume(slider.value / 100);
					this._updateWidget();
				});
			}
		});
	}

	/** Fetch the file list for a world/mood folder from the server. Cached. */
	async _listFiles(world, mood) {
		const key = `${world}/${mood}`;
		if (this._fileCache[key]) return this._fileCache[key];

		try {
			const res = await fetch(`/api/game-music/${world}/${mood}`);
			if (!res.ok) return [];
			const files = await res.json();
			if (files.length) this._fileCache[key] = files;
			return files;
		} catch {
			return [];
		}
	}

	/** Derive a display title from a filename like "tense_battle_crimson_steel_mn9abc.mp3" */
	_titleFromFilename(file) {
		return file
			.replace(/\.mp3$/i, "")
			.replace(/_[a-z0-9]{12}$/, "")
			.replace(/^[a-z_]+?_(?=[a-z])/, (match) => {
				for (const mood of Object.keys(MOOD_LABELS)) {
					if (match.startsWith(mood + "_")) return "";
				}
				return match;
			})
			.replace(/_/g, " ")
			.replace(/\b\w/g, c => c.toUpperCase());
	}

	_crossfadeTo(url) {
		const newAudio = new Audio(url);
		newAudio.loop   = true;
		newAudio.volume = 0;

		newAudio.play().catch(err => console.warn("🎵 Playback failed:", err.message));

		const file = url.split("/").pop();
		this.recentlyPlayed.push(file);
		if (this.recentlyPlayed.length > 3) this.recentlyPlayed.shift();

		const oldAudio = this.audio;
		this.audio     = newAudio;

		this._fadeIn(newAudio);

		if (oldAudio) {
			this._fadeOut(oldAudio, () => {
				oldAudio.pause();
				oldAudio.src = "";
			});
		}
	}

	_fadeIn(audioEl, durationMs = FADE_DURATION_MS) {
		clearInterval(this._fadeTimer);
		const targetVolume = this.muted ? 0 : this.volume;
		const step         = targetVolume / FADE_STEPS;
		const interval     = durationMs / FADE_STEPS;
		let   current      = 0;

		this._fadeTimer = setInterval(() => {
			current = Math.min(targetVolume, current + step);
			audioEl.volume = current;
			if (current >= targetVolume) clearInterval(this._fadeTimer);
		}, interval);
	}

	_fadeOut(audioEl, onDone) {
		const startVol = audioEl.volume;
		const step     = startVol / FADE_STEPS;
		const interval = FADE_DURATION_MS / FADE_STEPS;
		let   current  = startVol;

		const timer = setInterval(() => {
			current = Math.max(0, current - step);
			audioEl.volume = current;
			if (current <= 0) {
				clearInterval(timer);
				if (onDone) onDone();
			}
		}, interval);
	}
}

window.musicManager = new MusicManager();
