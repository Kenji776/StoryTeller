/**
 * selectors — derive everything the interface renders from one lobby state object.
 *
 * `LobbyStore.publicState` publishes the lobby as the server stores it: `players` is
 * a map of raw character records, `initiative` is an array of names and `turnIndex`
 * points into it. Sections should not each re-derive "whose turn is it" from that,
 * and the old panel's attempt to (`state.initiative?.current`, on an array) is why
 * its Turn card never showed anything.
 *
 * Keeping the derivation here means it is written once, tested once, and every
 * section agrees.
 */

/** Shown where a setting exists but was never chosen. */
const UNSET = "—";

/**
 * @description Reads a finite number, or falls back.
 * @param {*} value - The candidate.
 * @param {number} fallback - Used when `value` is not a finite number.
 * @returns {number} The number.
 */
function num(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @description Renders a music mood id as words.
 * @param {*} mood - A mood id such as `"tense_combat"`.
 * @returns {string} The mood in words, or `"none"`.
 */
function moodLabel(mood) {
	return typeof mood === "string" && mood ? mood.replace(/_/g, " ") : "none";
}

/**
 * @description Resolves the active turn from the shape `publicState` actually
 *   publishes.
 *
 *   `initiative` is an array of player names and `turnIndex` an index into it —
 *   not an object with `current` and `round` fields. Reading it as the latter is
 *   the defect this replaces. A pointer outside the order resolves to nobody
 *   rather than throwing, because a corrupted order is one of the conditions the
 *   repair catalogue exists to fix and the panel has to render it to offer the fix.
 * @param {object|null} state - A lobby `publicState`, or null when disconnected.
 * @returns {{current: string|null, round: number, order: Array<string>, index: number}}
 *   The active player, the round, the full order, and the pointer into it.
 */
export function selectTurn(state) {
	const order = Array.isArray(state?.initiative) ? state.initiative : [];
	const index = num(state?.turnIndex, -1);
	const inRange = Number.isInteger(index) && index >= 0 && index < order.length;

	return {
		current: inRange ? order[index] : null,
		round: num(state?.round, 1),
		order,
		index: inRange ? index : -1,
	};
}

/**
 * @description Flattens the lobby's player map into rows for the party table.
 *
 *   Hit points are read from `stats` with a flat fallback because character records
 *   written by different code paths disagree about where they live.
 * @param {object|null} state - A lobby `publicState`, or null when disconnected.
 * @returns {Array<object>} One row per character, in the lobby's own ordering.
 */
export function selectPlayers(state) {
	const players = state?.players;
	if (!players || typeof players !== "object") return [];

	const { current } = selectTurn(state);
	const connected = new Set(
		(Array.isArray(state?.connected) ? state.connected : []).map((entry) => entry?.name),
	);

	return Object.entries(players).map(([key, player]) => {
		const record = player ?? {};
		const name = record.name || key;
		return {
			name,
			race: record.race ?? null,
			charClass: record.class ?? null,
			level: num(record.level, 1),
			xp: num(record.xp, 0),
			gold: num(record.gold, 0),
			hp: num(record.stats?.hp ?? record.hp, 0),
			maxHp: num(record.stats?.max_hp ?? record.max_hp, 0),
			// Copied, so a section sorting or clearing the row's conditions cannot
			// edit the lobby state the store is holding.
			conditions: Array.isArray(record.conditions) ? [...record.conditions] : [],
			spellSlotsUsed: num(record.spellSlotsUsed, 0),
			dead: !!record.dead,
			isCurrent: name === current,
			connected: connected.has(name),
		};
	});
}

/**
 * @description Summarises the lobby for the dashboard's stat tiles.
 * @param {object|null} state - A lobby `publicState`, or null when disconnected.
 * @returns {object} Counts and headline values, all pre-formatted for display.
 */
export function selectVitals(state) {
	const players = selectPlayers(state);
	const { current, round } = selectTurn(state);
	const provider = state?.llmProvider;
	const model = state?.llmModel;

	return {
		code: state?.code ?? null,
		adventureName: state?.adventureName || "Untitled Adventure",
		phase: state?.phase || (state ? "unknown" : "disconnected"),
		round,
		turn: current,
		alive: players.filter((p) => !p.dead).length,
		dead: players.filter((p) => p.dead).length,
		total: players.length,
		connectedCount: Array.isArray(state?.connected) ? state.connected.length : 0,
		music: moodLabel(state?.currentMusic),
		model: provider || model ? `${provider ?? "?"} / ${model ?? "?"}` : "not set",
		timer: state?.timerEnabled ? `${num(state.timerMinutes, 5)} min` : "off",
	};
}

/**
 * @description Lists the enemies currently in play.
 *
 *   `publicState` already reduces enemy hit points to a condition word, so the
 *   party cannot read exact monster HP out of a socket frame. That reduction is
 *   preserved here rather than undone.
 * @param {object|null} state - A lobby `publicState`, or null when disconnected.
 * @returns {Array<object>} One row per enemy.
 */
export function selectEnemies(state) {
	const enemies = Array.isArray(state?.enemies) ? state.enemies : [];
	return enemies.map((enemy) => ({
		name: enemy?.name ?? "Unknown",
		cr: enemy?.cr ?? null,
		status: enemy?.status ?? null,
		condition: enemy?.condition ?? null,
		defeated: enemy?.status === "dead" || enemy?.status === "fled",
	}));
}

/**
 * @description Collects the campaign settings the server publishes read-only.
 *
 *   These are shown rather than edited: every one of them is set when the game is
 *   created, and adding a mutation path for each would mean a matching socket
 *   event and a server-side validator per field.
 * @param {object|null} state - A lobby `publicState`, or null when disconnected.
 * @returns {Array<{label: string, value: string}>} Label/value pairs to display.
 */
export function selectCampaign(state) {
	if (!state) return [];

	/**
	 * @description Renders one of the emoji-and-label settings.
	 * @param {object|null} setting - A `{label, emoji}` pair, or null.
	 * @returns {string} The rendered value.
	 */
	const decorated = (setting) => {
		if (!setting?.label) return UNSET;
		return setting.emoji ? `${setting.emoji} ${setting.label}` : setting.label;
	};

	const tts = state.ttsProvider;
	const voice = state.narratorVoiceName;

	return [
		{ label: "Tone", value: decorated(state.campaignTone) },
		{ label: "Theme", value: decorated(state.campaignTheme) },
		{ label: "Setting", value: state.campaignSetting || UNSET },
		{ label: "Difficulty", value: state.difficulty || UNSET },
		// Zero is a meaningful brutality, so it must not be treated as unset.
		{ label: "Brutality", value: Number.isFinite(Number(state.brutalityLevel)) ? `${Number(state.brutalityLevel)} / 10` : UNSET },
		{ label: "Loot", value: state.lootGenerosity || UNSET },
		{ label: "Starting level", value: String(num(state.startingLevel, 1)) },
		{ label: "Turn timer", value: state.timerEnabled ? `${num(state.timerMinutes, 5)} min` : "off" },
		{ label: "Narration", value: tts ? (voice ? `${tts} — ${voice}` : tts) : "off" },
	];
}

/**
 * @description Builds the multi-lobby overview from `/api/lobbies`.
 *
 *   Ordered by most recent activity, because the lobby someone is asking about is
 *   almost always the one that just did something. Lobbies with no recorded
 *   activity sort last rather than first, which is what a null would otherwise do.
 * @param {Array<object>} lobbies - The endpoint's `lobbies` array.
 * @param {string|null} [connectedCode] - The code currently connected, if any.
 * @returns {Array<object>} A new array holding one card per lobby.
 */
export function selectLobbyCards(lobbies, connectedCode = null) {
	if (!Array.isArray(lobbies)) return [];

	const cards = lobbies.map((lobby) => {
		const players = Array.isArray(lobby?.players) ? lobby.players : [];
		return {
			code: lobby?.code ?? null,
			adventureName: lobby?.adventureName || "Untitled Adventure",
			phase: lobby?.phase || "waiting",
			playerCount: num(lobby?.playerCount, players.length),
			players,
			connectedCount: players.filter((p) => p?.connected).length,
			hostName: players.find((p) => p?.isHost)?.name ?? null,
			lastActivity: Number.isFinite(lobby?.lastActivity) ? lobby.lastActivity : null,
			hasPassword: !!lobby?.hasPassword,
			isConnected: !!connectedCode && lobby?.code === connectedCode,
		};
	});

	return cards.sort((a, b) => {
		if (a.lastActivity === b.lastActivity) return 0;
		if (a.lastActivity === null) return 1;
		if (b.lastActivity === null) return -1;
		return b.lastActivity - a.lastActivity;
	});
}
