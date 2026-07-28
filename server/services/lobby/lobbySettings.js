/**
 * Settings, configuration, password, rest voting, and chat methods for LobbyStore.
 * Mixed into LobbyStore.prototype by the main module.
 */

import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { getDefaultLLMSettings } from "../llm/defaults.js";
import { TTS_PROVIDERS } from "../tts/registry.js";
import { ILLUSTRATION_MODES } from "../images/illustration.js";

/** The registry is the single source of truth for which provider ids are legal. */
const TTS_PROVIDER_IDS = TTS_PROVIDERS.map((p) => p.id);

/**
 * Provider a lobby's current narrator voice belongs to.
 *
 * @description Lobbies persisted before TTS became pluggable carry an ElevenLabs
 *   voice id and no `ttsProvider` at all, so that is the correct attribution for
 *   an absent value — not a guess, but what those ids actually are.
 * @param {object} lobby - The raw lobby state object.
 * @returns {string} A provider id.
 */
function activeProviderOf(lobby) {
	return lobby.ttsProvider || "elevenlabs";
}

/**
 * The lobby's per-provider voice memory, created on first use.
 *
 * @param {object} lobby - The raw lobby state object.
 * @returns {object} Map of provider id to `{id, name}` or null.
 */
function voiceBook(lobby) {
	if (!lobby.narratorVoices || typeof lobby.narratorVoices !== "object") {
		// Seed from the legacy single-voice field so an existing lobby does not lose
		// the voice it has been narrating with.
		lobby.narratorVoices = lobby.narratorVoiceId
			? { [activeProviderOf(lobby)]: { id: lobby.narratorVoiceId, name: lobby.narratorVoiceName || null } }
			: {};
	}
	return lobby.narratorVoices;
}

export const settingsMethods = {
	// ==== Password ====

	/**
	 * Hashes and stores a password for the lobby, marking it as private.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} clientHash - The pre-hashed password string from the client.
	 * @returns {void}
	 */
	setPassword(lobbyId, clientHash) {
		const l = this.index[lobbyId];
		if (!l) return;
		const salt = randomBytes(16).toString("hex");
		const hash = scryptSync(clientHash, salt, 64).toString("hex");
		l.isPrivate = true;
		l.passwordHash = hash;
		l.passwordSalt = salt;
		this.persist(lobbyId);
	},

	/**
	 * Verifies a client-supplied hash against the stored lobby password.
	 * Returns true if the lobby has no password set (open lobby).
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} clientHash - The pre-hashed password string from the client.
	 * @returns {boolean} True if the password matches or no password is set; false otherwise.
	 */
	verifyPassword(lobbyId, clientHash) {
		const l = this.index[lobbyId];
		if (!l || !l.passwordHash) return true;
		try {
			const derived = scryptSync(clientHash, l.passwordSalt, 64);
			return timingSafeEqual(derived, Buffer.from(l.passwordHash, "hex"));
		} catch {
			return false;
		}
	},

	// ==== Rest Voting ====

	/**
	 * Initiates a rest vote in the lobby, casting the proposer's vote as "yes" automatically.
	 * Fails if a vote is already in progress.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} proposer - The player name proposing the rest.
	 * @param {string} type - The rest type, e.g. "short" or "long".
	 * @returns {boolean} True if the vote was started; false if one is already active.
	 */
	startRestVote(lobbyId, proposer, type) {
		const l = this.index[lobbyId];
		if (!l || l.activeRestVote) return false;
		const activePlayers = Object.keys(l.players).filter(n => !l.players[n]?.disconnected);
		l.activeRestVote = { type, proposer, votes: { [proposer]: "yes" }, total: activePlayers.length };
		this.persist(lobbyId);
		return true;
	},

	/**
	 * Records a player's vote on the active rest vote. A player may only vote once.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} playerName - The name of the voting player.
	 * @param {"yes"|"no"} vote - The player's vote.
	 * @returns {object|null} The current vote state, or null if no active vote or player already voted.
	 */
	castVote(lobbyId, playerName, vote) {
		const l = this.index[lobbyId];
		if (!l?.activeRestVote || l.activeRestVote.votes[playerName]) return null;
		l.activeRestVote.votes[playerName] = vote;
		this.persist(lobbyId);
		return this.getVoteState(lobbyId);
	},

	/**
	 * Returns a summary of the current rest vote, including yes/no counts and pending voters.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {{ type: string, proposer: string, yesVotes: string[], noVotes: string[], pending: string[], total: number }|null} Vote state, or null if no active vote.
	 */
	getVoteState(lobbyId) {
		const l = this.index[lobbyId];
		if (!l?.activeRestVote) return null;
		const { type, proposer, votes, total } = l.activeRestVote;
		const yesVotes = Object.entries(votes).filter(([, v]) => v === "yes").map(([k]) => k);
		const noVotes  = Object.entries(votes).filter(([, v]) => v === "no").map(([k]) => k);
		const pending  = Object.keys(l.players).filter(n => !votes[n] && !l.players[n]?.disconnected);
		return { type, proposer, yesVotes, noVotes, pending, total };
	},

	/**
	 * Determines whether the active rest vote has reached a conclusive outcome.
	 * Returns null if the vote is still ongoing.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {"passed"|"failed"|null} The outcome, or null if still pending.
	 */
	checkVoteResolved(lobbyId) {
		const s = this.getVoteState(lobbyId);
		if (!s) return null;
		const { yesVotes, noVotes, total, pending } = s;
		if (pending.length === 0) return noVotes.length < yesVotes.length ? "passed" : "failed";
		if (yesVotes.length > total / 2) return "passed";
		if (noVotes.length >= Math.ceil(total / 2)) return "failed";
		return null;
	},

	/**
	 * Clears the active rest vote from the lobby state and persists.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {void}
	 */
	clearRestVote(lobbyId) {
		const l = this.index[lobbyId];
		if (l) { l.activeRestVote = null; this.persist(lobbyId); }
	},

	/**
	 * Applies short or long rest effects to all players in the lobby.
	 * Long rest fully restores HP, clears conditions, and resets spell slots.
	 * Short rest restores up to one third of max HP.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {"short"|"long"} type - The type of rest to apply.
	 * @returns {void}
	 */
	applyRest(lobbyId, type) {
		const l = this.index[lobbyId];
		if (!l) return;
		for (const p of Object.values(l.players)) {
			if (!p.stats) continue;
			const max = p.stats.max_hp || p.stats.hp || 10;
			if (type === "long") {
				p.stats.hp = max;
				p.conditions = [];
				p.spellSlotsUsed = 0;
			} else {
				p.stats.hp = Math.min(max, p.stats.hp + Math.max(1, Math.floor(max / 3)));
			}
		}
		this.persist(lobbyId);
	},

	// ==== Timer / Voice / Music ====

	/**
	 * Configures turn-timer settings for the lobby, clamping values to valid ranges.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {boolean} enabled - Whether the turn timer is active.
	 * @param {number} minutes - Turn duration in minutes (clamped 1–20).
	 * @param {number} maxMissed - Max missed turns before action (clamped 1–10).
	 * @returns {void}
	 */
	setTimerSettings(lobbyId, enabled, minutes, maxMissed) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.timerEnabled = !!enabled;
		s.timerMinutes = Math.min(20, Math.max(1, Number(minutes) || 5));
		s.maxMissedTurns = Math.min(10, Math.max(1, Number(maxMissed) || 3));
		this.persist(lobbyId);
	},

	/**
	 * Selects which TTS engine narrates this lobby, and restores that engine's voice.
	 *
	 * @description Voice ids are provider-specific — an ElevenLabs id means nothing
	 *   to the local server and "House" means nothing to ElevenLabs — so each
	 *   provider's last chosen voice is remembered separately and swapped into the
	 *   active slot here. A host can switch back and forth without re-picking.
	 *
	 *   Unlike the neighbouring setters, an unrecognised id is *ignored* rather than
	 *   coerced to a default: coercion would let a malformed message silently move a
	 *   lobby off the engine its host chose. Availability is not checked here; that
	 *   is `normalizeProviderId`'s job at narration time, so a lobby survives its
	 *   provider going offline and coming back.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string|null} providerId - A registered provider id, or null to clear.
	 * @returns {void}
	 */
	setTTSProvider(lobbyId, providerId) {
		const s = this.index[lobbyId];
		if (!s) return;
		if (providerId !== null && !TTS_PROVIDER_IDS.includes(providerId)) return;

		// Seed the book before switching: it attributes an unfiled legacy voice to
		// whichever provider is active, and after the switch that would be the wrong one.
		const book = voiceBook(s);
		s.ttsProvider = providerId;

		const remembered = providerId ? book[providerId] : null;
		s.narratorVoiceId   = remembered?.id   || null;
		s.narratorVoiceName = remembered?.name || null;
		this.persist(lobbyId);
	},

	/**
	 * Returns the TTS engine this lobby narrates with.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {string|null} A provider id, or null if none was ever chosen.
	 */
	getTTSProvider(lobbyId) {
		return this.index[lobbyId]?.ttsProvider || null;
	},

	/**
	 * Sets the narrator voice ID and optional display name for the lobby.
	 *
	 * @description Also files the choice under the active provider so it survives a
	 *   round trip through another engine — see `setTTSProvider`.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string|null} voiceId - The TTS voice identifier.
	 * @param {string|null} [voiceName=null] - Human-readable voice name.
	 * @returns {void}
	 */
	setNarratorVoice(lobbyId, voiceId, voiceName = null) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.narratorVoiceId   = voiceId   || null;
		s.narratorVoiceName = voiceName || null;
		voiceBook(s)[activeProviderOf(s)] = voiceId ? { id: voiceId, name: voiceName || null } : null;
		this.persist(lobbyId);
	},

	/**
	 * Returns the narrator voice ID for the lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {string|null} The voice ID, or null if not set.
	 */
	getNarratorVoice(lobbyId) {
		return this.index[lobbyId]?.narratorVoiceId || null;
	},

	/**
	 * Sets the current background music mood for the lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string|null} mood - The music mood identifier, or null to clear.
	 * @returns {void}
	 */
	setCurrentMusic(lobbyId, mood) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.currentMusic = mood || null;
		this.persist(lobbyId);
	},

	/**
	 * Returns the current music mood for the lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {string|null} The current music mood, or null if not set.
	 */
	getCurrentMusic(lobbyId) {
		return this.index[lobbyId]?.currentMusic || null;
	},

	// ==== Brutality / Difficulty / Loot / Setting ====

	/**
	 * Sets the brutality level for the lobby, clamped to the range 0–10.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {number} level - Brutality level (0 = lenient, 10 = brutal).
	 * @returns {void}
	 */
	setBrutalityLevel(lobbyId, level) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.brutalityLevel = Math.min(10, Math.max(0, Number(level) ?? 5));
		this.persist(lobbyId);
	},

	/**
	 * Sets the difficulty preset for the lobby. Falls back to "standard" if the value is invalid.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {"casual"|"standard"|"hardcore"|"merciless"} value - The difficulty preset.
	 * @returns {void}
	 */
	setDifficulty(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		const valid = ["casual", "standard", "hardcore", "merciless"];
		s.difficulty = valid.includes(value) ? value : "standard";
		this.persist(lobbyId);
	},

	/**
	 * Sets the loot generosity level for the lobby. Falls back to "fair" if the value is invalid.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {"sparse"|"fair"|"generous"} value - The loot generosity level.
	 * @returns {void}
	 */
	setLootGenerosity(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		const valid = ["sparse", "fair", "generous"];
		s.lootGenerosity = valid.includes(value) ? value : "fair";
		this.persist(lobbyId);
	},

	/**
	 * Sets the campaign setting/theme for the lobby. Falls back to "standard" if the value is invalid.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} value - One of the recognised campaign setting identifiers.
	 * @returns {void}
	 */
	setCampaignSetting(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		const valid = ["standard", "dark_ages", "steampunk", "pirate", "scifi", "ancient_egypt", "ancient_rome", "warring_states_japan", "prehistory", "renaissance"];
		s.campaignSetting = valid.includes(value) ? value : "standard";
		this.persist(lobbyId);
	},

	/**
	 * Sets the starting character level for new players in the lobby, clamped to 1–25.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {number} level - Starting level (clamped 1–25).
	 * @returns {void}
	 */
	setStartingLevel(lobbyId, level) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.startingLevel = Math.min(25, Math.max(1, Number(level) || 1));
		this.persist(lobbyId);
	},

	/**
	 * Sets how many ability activations a level-one character starts with.
	 *
	 * The pool still grows by one per level on top of this, so the default of 1
	 * reproduces the original behaviour exactly. Hosts who found one activation per
	 * level-one session too tight can raise it, or lift the limit entirely.
	 *
	 * @param {string} lobbyId - The lobby identifier.
	 * @param {number|"unlimited"} value - Activations at level one, or "unlimited".
	 * @returns {void}
	 */
	setAbilitySlotsBase(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		if (value === "unlimited") {
			s.abilitySlotsBase = "unlimited";
		} else {
			const n = Number(value);
			// Capped at a number no campaign will reach, so a typo cannot make the pool
			// effectively unlimited without the host choosing that explicitly.
			s.abilitySlotsBase = Number.isFinite(n) && n >= 0 ? Math.min(999, Math.floor(n)) : 1;
		}
		this.persist(lobbyId);
	},
	/**
	 * Sets the campaign tone and/or theme flavor text. Only updates fields that are explicitly provided.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string|null|undefined} tone - The narrative tone (e.g. "grim", "heroic"), or undefined to skip.
	 * @param {string|null|undefined} theme - The campaign theme (e.g. "political intrigue"), or undefined to skip.
	 * @returns {void}
	 */
	setCampaignFlavor(lobbyId, tone, theme) {
		const s = this.index[lobbyId];
		if (!s) return;
		if (tone  !== undefined) s.campaignTone  = tone  || null;
		if (theme !== undefined) s.campaignTheme = theme || null;
		this.persist(lobbyId);
	},

	/**
	 * Sets the adventure/campaign name for the lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} name - The display name for the adventure.
	 * @returns {void}
	 */
	setAdventureName(lobbyId, name) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.adventureName = name;
		this.persist(lobbyId);
	},

	/**
	 * Sets how freely the Dungeon Master may call for illustrations.
	 *
	 * @description Off by default. An image costs seconds of wall clock and, on a
	 *   paid provider, money — so a game only draws them once someone has asked for
	 *   it, rather than the first session surprising a host with a bill.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {"off"|"key-moments"|"generous"} value - How often to illustrate.
	 * @returns {void}
	 */
	setIllustrationMode(lobbyId, value) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.illustrationMode = ILLUSTRATION_MODES.includes(value) ? value : "off";
		this.persist(lobbyId);
	},

	/**
	 * @description Records when this lobby last drew something, for the cooldown.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {number} at - Epoch milliseconds.
	 * @returns {void}
	 */
	markIllustrated(lobbyId, at) {
		const s = this.index[lobbyId];
		if (!s) return;
		s.lastIllustrationAt = at;
		this.persist(lobbyId);
	},

	// ==== LLM Settings ====

	/**
	 * Overrides the LLM provider and/or model for the lobby. Skips falsy values.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string|null} provider - The LLM provider identifier (e.g. "openai", "anthropic").
	 * @param {string|null} model - The model identifier (e.g. "gpt-4o").
	 * @returns {void}
	 */
	setLLMSettings(lobbyId, provider, model) {
		const s = this.index[lobbyId];
		if (!s) return;
		if (provider) s.llmProvider = provider;
		if (model)    s.llmModel    = model;
		this.persist(lobbyId);
	},

	/**
	 * Returns the lobby's LLM provider and model, falling back to system defaults.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {{ provider: string, model: string }} The active LLM configuration.
	 */
	getLLMSettings(lobbyId) {
		const s = this.index[lobbyId];
		return {
			lobbyId,
			provider: s?.llmProvider || getDefaultLLMSettings().provider,
			model:    s?.llmModel    || getDefaultLLMSettings().model,
		};
	},

	// ==== Chat ====

	/**
	 * Returns the most recent chat messages for the lobby, up to the specified limit.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {number} [limit=50] - Maximum number of messages to return.
	 * @returns {Array<{ name: string, text: string, timestamp: number }>} The chat message slice.
	 */
	getChat(lobbyId, limit = 50) {
		const l = this.index[lobbyId];
		if (!l) return [];
		l.chat = l.chat || [];
		return l.chat.slice(-limit);
	},

	/**
	 * Appends a chat message to the lobby history. Trims the log to the last 500 messages.
	 * @param {string} lobbyId - The target lobby ID.
	 * @param {string} name - The sender's display name.
	 * @param {string} text - The message content.
	 * @returns {void}
	 */
	appendChat(lobbyId, name, text) {
		const l = this.index[lobbyId];
		if (!l) return;
		l.chat = l.chat || [];
		l.chat.push({ name, text, timestamp: Date.now() });
		if (l.chat.length > 500) l.chat = l.chat.slice(-500);
		this.persist(lobbyId);
	},

	/**
	 * Returns the unique player names of all currently connected socket sessions in the lobby.
	 * @param {string} lobbyId - The target lobby ID.
	 * @returns {string[]} Deduplicated list of connected player names.
	 */
	getChatUsers(lobbyId) {
		const l = this.index[lobbyId];
		if (!l) return [];
		const users = Object.values(l.sockets)
			.map((s) => s.playerName)
			.filter((n) => !!n && typeof n === "string");
		return [...new Set(users)];
	},
};
