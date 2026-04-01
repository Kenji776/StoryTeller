// === MusicManager ===
// Loads /config/library.json, matches LLM mood requests to local songs using
// tag-overlap scoring, and handles crossfade playback.

const MOOD_LABELS = {
	lively_town:     "Lively Town",
	tense_battle:    "Tense Battle",
	boss_fight:      "Boss Fight",
	peaceful_nature: "Peaceful Nature",
	dungeon_ambient: "Dungeon Ambient",
	tavern:          "Tavern",
	mystery:         "Mystery",
	exploration:     "Exploration",
	sad_moment:      "Sad Moment",
	victory:         "Victory",
	horror:          "Horror",
};

const FADE_DURATION_MS = 2500;
const FADE_STEPS       = 50;

class MusicManager {
	constructor() {
		this.library        = null;      // loaded from library.json
		this.currentMood    = null;
		this.currentFile    = null;
		this.currentTitle   = null;
		this.audio          = null;      // currently playing Audio element
		this.recentlyPlayed = [];        // last 3 files, to avoid instant repeats
		this.muted          = false;
		this.volume         = 0.35;      // default background volume
		this._fadeTimer     = null;
		this._bindControls();
	}

	async load() {
		try {
			const res = await fetch("/config/library.json");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			this.library = await res.json();
			console.log(`🎵 Music library loaded — ${this.library.songs?.length ?? 0} songs`);
		} catch (err) {
			console.warn("🎵 Music library unavailable:", err.message);
		}
	}

	// Called by the socket handler when the DM specifies a music mood.
	requestMood(mood) {
		if (!this.library?.songs?.length) return;
		if (mood === this.currentMood) return; // no change needed

		const song = this._findBestMatch(mood);
		if (!song) {
			console.warn(`🎵 No song found for mood "${mood}"`);
			return;
		}

		this.currentMood  = mood;
		this.currentTitle = song.title;
		this._crossfadeTo(song);
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

	// ── Private ───────────────────────────────────────────────────────────────

	_findBestMatch(mood) {
		const moodTags = this.library.moods?.[mood] || [];
		const songs    = this.library.songs || [];

		// Prefer songs not recently played
		const pool = songs.filter(s => !this.recentlyPlayed.includes(s.file));
		const candidates = pool.length ? pool : songs;

		let bestScore = -1;
		let winners   = [];

		for (const song of candidates) {
			const tags  = Array.isArray(song.tags) ? song.tags : [];
			const score = tags.filter(t => moodTags.includes(t)).length;
			if (score > bestScore) {
				bestScore = score;
				winners   = [song];
			} else if (score === bestScore) {
				winners.push(song);
			}
		}

		// Random tiebreaking so the same song isn't always chosen
		return winners[Math.floor(Math.random() * winners.length)] || null;
	}

	_crossfadeTo(song) {
		const newAudio = new Audio(`/music/${song.file}`);
		newAudio.loop   = true;
		newAudio.volume = 0;

		newAudio.play().catch(err => console.warn("🎵 Playback failed:", err.message));

		// Track recently played
		this.recentlyPlayed.push(song.file);
		if (this.recentlyPlayed.length > 3) this.recentlyPlayed.shift();
		this.currentFile = song.file;

		const oldAudio = this.audio;
		this.audio     = newAudio;

		// Fade in new track
		this._fadeIn(newAudio);

		// Fade out and discard old track
		if (oldAudio) {
			this._fadeOut(oldAudio, () => {
				oldAudio.pause();
				oldAudio.src = "";
			});
		}
	}

	_fadeIn(audioEl) {
		clearInterval(this._fadeTimer);
		const targetVolume = this.muted ? 0 : this.volume;
		const step         = targetVolume / FADE_STEPS;
		const interval     = FADE_DURATION_MS / FADE_STEPS;
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

	_bindControls() {
		// Defer until DOM is ready
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

	/** Make the music row visible (called once when entering game mode). */
	showWidget() {
		const row     = document.getElementById("musicRow");
		const divider = document.getElementById("audioDivider");
		if (row)     row.classList.remove("hidden");
		if (divider) divider.classList.remove("hidden");
		this._updateWidget();
	}

	_updateWidget() {
		const muteBtn   = document.getElementById("musicMuteBtn");
		const titleEl   = document.getElementById("musicSongTitle");
		const slider    = document.getElementById("musicVolumeSlider");

		if (titleEl) {
			titleEl.textContent = this.currentMood
				? (this.currentTitle || MOOD_LABELS[this.currentMood] || this.currentMood.replace(/_/g, " "))
				: "No music";
		}
		if (muteBtn) muteBtn.textContent = this.muted ? "🔇" : "🎵";
		if (slider && !slider.matches(":active")) slider.value = Math.round(this.muted ? 0 : this.volume * 100);
	}
}

window.musicManager = new MusicManager();
window.musicManager.load();
