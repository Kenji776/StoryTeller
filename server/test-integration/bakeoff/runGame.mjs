/**
 * runGame.mjs — drives one real game for one model and reports what happened.
 *
 * This is the network half of the bake-off. It plays a genuine multiplayer game
 * over real sockets against a running server, so the model is judged on the
 * prompt the game actually sends rather than a hand-written approximation of it
 * (see ADR 0028). The grading half is pure and lives in
 * `server/services/bakeoff/`.
 *
 * What this returns is deliberately *not* a grade. It returns the lobby id and the
 * operational counters; the reply text is read afterwards from the gateway's call
 * journal, which is the only complete record of what the model said — the socket
 * transcript shows only what survived parsing, and a bad model's failures are
 * mostly things that did not survive parsing.
 *
 * Needs a live server and a real key, and it costs money. Run it by hand, and
 * prefer a dev-mode instance on its own port so narration and image spend are off.
 */

import { io } from "socket.io-client";
import { buildActionScript, ACTION_CATEGORIES } from "../../services/bakeoff/actionScript.js";

/** Rejection codes decided in pure code, before any model is consulted. */
const HARD_CHECK_CODES = new Set(["empty", "too_long", "no_character", "cannot_act", "no_slots", "unknown_ability"]);

/** Heavy armour, the best on any level-1 starting list. */
const CHAIN_MAIL = { name: "Chain Mail", ac: 16, type: "heavy", note: "" };

/**
 * A party built to survive, so a run ends because its turn budget ran out rather
 * than because the party died on turn nine.
 *
 * @description A total party kill truncates the run and would show up as a
 * reliability failure, charging the model for running a lethal game — which is not
 * what is being measured. Two fighters and two clerics in chain mail, every point
 * in the one stat that does anything at level 1, is the sturdiest party the rules
 * permit; see the reasoning in `playtest.mjs`'s MINMAX_CAST.
 */
const PARTY = [
	{
		name: "Dorn Hammerfall", cls: "Fighter", race: "Dwarf",
		stats: { hp: 10, max_hp: 10, str: 18, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
		abilities: [{ name: "Second Wind", description: "Regain hit points as a bonus action.", details: {} }],
		spells: [],
		weapon: { name: "Greatsword", damage: "2d6", damageType: "slashing", range: "melee" },
		armor: CHAIN_MAIL,
	},
	{
		name: "Kestra Vane", cls: "Fighter", race: "Human",
		stats: { hp: 10, max_hp: 10, str: 18, dex: 8, con: 8, int: 8, wis: 8, cha: 8 },
		abilities: [{ name: "Second Wind", description: "Regain hit points as a bonus action.", details: {} }],
		spells: [],
		weapon: { name: "Greatsword", damage: "2d6", damageType: "slashing", range: "melee" },
		armor: CHAIN_MAIL,
	},
	{
		name: "Sister Almath", cls: "Cleric", race: "Human",
		stats: { hp: 10, max_hp: 10, wis: 18, dex: 8, con: 8, int: 8, str: 8, cha: 8 },
		abilities: [],
		spells: ["Guiding Bolt", "Sacred Flame", "Cure Wounds"],
		weapon: { name: "Warhammer", damage: "1d8", damageType: "bludgeoning", range: "melee" },
		armor: CHAIN_MAIL,
	},
	{
		name: "Brother Oduin", cls: "Cleric", race: "Dwarf",
		stats: { hp: 10, max_hp: 10, wis: 18, dex: 8, con: 8, int: 8, str: 8, cha: 8 },
		abilities: [],
		spells: ["Cure Wounds", "Sacred Flame", "Guiding Bolt"],
		weapon: { name: "Warhammer", damage: "1d8", damageType: "bludgeoning", range: "melee" },
		armor: CHAIN_MAIL,
	},
];

/** A safe action used to retry after a refusal, so a rejected turn still resolves. */
const RETRY_ACTION = "I take a careful look around and stay ready.";

/** @description Sleeps. @param {number} ms - Duration. @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @description Builds a character sheet in the shape the real client sends.
 * @param {object} spec - An entry from {@link PARTY}.
 * @returns {object} A server-acceptable sheet.
 */
function makeSheet(spec) {
	return {
		name: spec.name,
		class: spec.cls,
		race: spec.race,
		alignment: "Neutral Good",
		background: "Wanderer",
		deity: "", gender: "", age: "30", height: "5'10\"", weight: "170lb",
		level: 1,
		voice_id: null,
		description: `${spec.name}, a ${spec.race} ${spec.cls} of few words and fewer regrets.`,
		stats: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 10, ...spec.stats },
		abilities: spec.abilities,
		spells: spec.spells,
		inventory: [
			{ name: "Rations", count: 3, description: "Dry but filling.", attributes: {} },
			{ name: "Healing Potion", count: 2, description: "Restores health when drunk.", attributes: { healing: "2d4" } },
		],
		weapon: spec.weapon,
		armor: spec.armor,
	};
}

/**
 * @description Waits for a named event, resolving null on timeout rather than throwing,
 *   so a single slow frame does not abort a whole run.
 * @param {object} socket - A socket.io client.
 * @param {string} event - Event name.
 * @param {number} ms - Timeout in milliseconds.
 * @returns {Promise<object|null>} The payload, or null.
 */
function waitFor(socket, event, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
		function handler(payload) { clearTimeout(timer); socket.off(event, handler); resolve(payload); }
		socket.on(event, handler);
	});
}

/**
 * Plays one game and reports how it went.
 *
 * @description Every counter returned here is something the pure scorer cannot
 *   derive from the journal: whether a turn was actually completed, whether the
 *   table stalled, and — for the judgement dimension — which submitted actions were
 *   meant to be refused and which were not.
 * @param {object} options - Run options.
 * @param {string} options.url - Base URL of a running server.
 * @param {string} options.provider - Provider id to configure the lobby with.
 * @param {string} options.model - Model id to configure the lobby with.
 * @param {number} options.actions - Total player actions to attempt across the party.
 * @param {number} [options.turnTimeoutMs=180000] - How long one turn may take before
 *   it is treated as a stall. Generous, because a reasoning model can spend a minute
 *   thinking before a word appears.
 * @param {Function} [options.log] - Progress sink, called with one string.
 * @returns {Promise<object>} `{ lobbyId, code, ops, gate, endedBy, error }`.
 * @throws {Error} Only if the server cannot be reached to create a lobby at all;
 *   every later failure is reported in the result so the model still gets graded.
 */
export async function runGame({ url, provider, model, actions, turnTimeoutMs = 180_000, log = () => {} }) {
	const script = buildActionScript(actions);
	const requested = script.length;
	const result = {
		lobbyId: null, code: null, endedBy: "budget", error: null,
		ops: { requested, completed: 0, stalls: 0, providerErrors: 0 },
		gate: { badSubmitted: 0, badRejected: 0, plausibleSubmitted: 0, plausibleRejected: 0, hardChecks: 0 },
	};

	const players = PARTY.map((spec) => {
		const socket = io(url, { transports: ["websocket"], reconnection: true, reconnectionDelay: 300 });
		return { spec, socket, name: spec.name, lobbyId: null, dead: false, state: null, currentTurn: null };
	});
	const [host] = players;

	/** @description Closes every socket. @returns {void} */
	const teardown = () => { for (const p of players) { try { p.socket.disconnect(); } catch { /* already gone */ } } };

	try {
		for (const p of players) {
			// Whose turn it is only reaches clients inside the snapshot, as
			// initiative[turnIndex]; there is no turn:update for the opening turn.
			p.socket.on("state:update", (payload) => {
				if (!payload) return;
				p.state = payload;
				if (Array.isArray(payload.initiative)) p.currentTurn = payload.initiative[payload.turnIndex] ?? null;
			});
			p.socket.on("turn:update", (payload) => { if (payload) p.currentTurn = payload.current ?? null; });
			p.socket.on("player:death", ({ player }) => { if (player === p.name) p.dead = true; });

			// With TTS off the server still waits to be told the passage was read, so
			// this must be answered or the table stalls. Nobody is listening, so it is
			// answered at once rather than at reading speed.
			p.socket.on("narration:start", () => { if (p.lobbyId) p.socket.emit("narration:done", { lobbyId: p.lobbyId }); });

			// A rest vote stalls the table until everyone answers.
			p.socket.on("rest:vote:start", () => {
				setTimeout(() => p.socket.emit("rest:vote", { lobbyId: p.lobbyId, vote: "yes" }), 300);
			});

			// When the DM demands a check, action:submit returns early and nothing
			// schedules a turn timer, so an unanswered roll stalls the game forever.
			p.socket.on("roll:required", ({ player, sides, stats, mods, dc }) => {
				if (player !== p.name) return;
				const raw = Math.floor(Math.random() * (Number(sides) || 20)) + 1;
				const mine = p.state?.players?.[p.name]?.stats || {};
				let total = raw;
				const parts = [];
				for (const stat of stats || []) {
					const mod = Math.floor((Number(mine[String(stat).toLowerCase()] ?? 10) - 10) / 2);
					total += mod;
					parts.push(`${String(stat).toUpperCase()} ${mod >= 0 ? "+" : ""}${mod}`);
				}
				const flat = Number(mods) || 0;
				if (flat) { total += flat; parts.push(`mod ${flat >= 0 ? "+" : ""}${flat}`); }
				const dcNum = Number(dc) || 0;
				const text = `[ROLL] ${p.name} rolls a d${sides} → ${raw}`
					+ (parts.length ? ` [${parts.join(", ")}]` : "")
					+ ` = ${total} total`
					+ (dcNum ? ` vs DC ${dcNum} — ${total >= dcNum ? "SUCCESS" : "FAILURE"}` : "") + "! [/ROLL]";
				setTimeout(() => p.socket.emit("action:submit", { lobbyId: p.lobbyId, text }), 400);
			});
		}

		await Promise.all(players.map((p) => waitFor(p.socket, "connect", 20_000)));

		host.socket.emit("lobby:create", {});
		const created = await waitFor(host.socket, "lobby:created", 20_000);
		if (!created?.lobbyId) throw new Error("the server never created a lobby");
		result.lobbyId = created.lobbyId;
		result.code = created.code;
		host.lobbyId = created.lobbyId;

		for (const p of players.slice(1)) {
			p.socket.emit("lobby:join", { code: created.code });
			const joined = await waitFor(p.socket, "lobby:joined", 20_000);
			p.lobbyId = joined?.lobbyId ?? created.lobbyId;
		}

		for (const p of players) {
			p.socket.emit("player:sheet", { lobbyId: p.lobbyId, name: p.name, sheet: makeSheet(p.spec) });
			await sleep(120);
		}
		for (const p of players) {
			p.socket.emit("player:ready", { lobbyId: p.lobbyId, ready: true });
			await sleep(80);
		}

		// Named explicitly rather than inherited from DEFAULT_LLM_PROVIDER: a run that
		// silently opened against the deployment's default would grade the wrong model.
		host.socket.emit("lobby:settings", {
			lobbyId: host.lobbyId,
			timerEnabled: true, timerMinutes: 2, maxMissedTurns: 99,
			abilitySlotsBase: 3, brutalityLevel: 5, difficulty: "standard",
			lootGenerosity: "fair", illustrationMode: "off",
			llmProvider: provider, llmModel: model,
		});
		await sleep(500);

		// Read the settings back: the server's log echoes only some of them, so a value
		// that never landed is otherwise invisible until the whole run is over.
		const applied = host.state ?? {};
		if (applied.llmProvider !== provider || applied.llmModel !== model) {
			throw new Error(`settings did not take: lobby is on ${applied.llmProvider}/${applied.llmModel}, wanted ${provider}/${model}`);
		}

		host.socket.emit("game:start", { lobbyId: host.lobbyId });
		const opening = await waitFor(host.socket, "narration", 180_000);
		if (!opening) {
			result.endedBy = "no-opening";
			result.error = "the model never produced an opening scene";
			return result;
		}

		// ── Turns ──
		let lastActed = null;
		let consecutiveStalls = 0;

		for (const step of script) {
			if (players.every((p) => p.dead)) { result.endedBy = "tpk"; break; }
			if (consecutiveStalls >= 3) { result.endedBy = "stall"; break; }

			// Poll the tracked turn: the server emits turn:update only on changes.
			let current = null;
			const turnDeadline = Date.now() + turnTimeoutMs;
			while (Date.now() < turnDeadline) {
				current = host.currentTurn;
				if (current && current !== lastActed) break;
				await sleep(400);
			}
			if (!current || current === lastActed) {
				result.ops.stalls++;
				consecutiveStalls++;
				lastActed = null;
				continue;
			}
			consecutiveStalls = 0;
			lastActed = current;

			const actor = players.find((p) => p.name === current);
			if (!actor) { result.ops.stalls++; continue; }
			if (actor.dead) { await sleep(1500); continue; }

			const resolved = await takeTurn({ actor, host, step, result, turnTimeoutMs });
			if (resolved) result.ops.completed++;
			else { result.ops.stalls++; consecutiveStalls++; }
		}

		if (players.every((p) => p.dead)) result.endedBy = "tpk";
		return result;
	} catch (err) {
		result.error = err.message;
		result.endedBy = "error";
		return result;
	} finally {
		// Give the last reply time to be journalled before the sockets go.
		await sleep(1200);
		teardown();
	}
}

/**
 * Submits one scripted action and waits for the table to move on.
 *
 * @description A refusal does not advance the turn, so the same player stays on the
 *   clock and somebody has to resubmit or the whole run deadlocks. That retry is also
 *   where the judgement dimension gets its data: the code on the rejection separates
 *   what the model judged (`implausible`) from what pure code refused before the model
 *   ever saw it.
 * @param {object} args - Turn arguments.
 * @param {object} args.actor - The player on the clock.
 * @param {object} args.host - The host player, whose socket watches for narration.
 * @param {object} args.step - The scripted `{text, category}`.
 * @param {object} args.result - The run result, mutated with gate and error counters.
 * @param {number} args.turnTimeoutMs - How long the turn may take.
 * @returns {Promise<boolean>} True when the turn produced narration.
 */
async function takeTurn({ actor, host, step, result, turnTimeoutMs }) {
	const isAbsurd = step.category === ACTION_CATEGORIES.ABSURD;
	if (isAbsurd) result.gate.badSubmitted++;
	else result.gate.plausibleSubmitted++;

	const outcome = await submitAndSettle({ actor, host, text: step.text, timeoutMs: turnTimeoutMs });

	if (outcome.kind === "rejected") {
		const hard = HARD_CHECK_CODES.has(outcome.code);
		if (hard) result.gate.hardChecks++;
		else if (isAbsurd) result.gate.badRejected++;
		else result.gate.plausibleRejected++;

		// The turn is still open. Resubmit something safe so the run continues.
		const retry = await submitAndSettle({ actor, host, text: RETRY_ACTION, timeoutMs: turnTimeoutMs });
		if (retry.kind === "narration") return true;
		if (retry.kind === "failure") result.ops.providerErrors++;
		return false;
	}

	if (outcome.kind === "failure") { result.ops.providerErrors++; return false; }
	return outcome.kind === "narration";
}

/**
 * @description Emits one action and resolves on the first thing that settles the turn.
 *
 *   A model failure is published to players as ordinary narration rather than as an
 *   error, so the text has to be sniffed: without this a run against a dead provider
 *   plays every turn to completion with "[Error: LLM unavailable]" as its whole story
 *   and reports a clean sweep.
 * @param {object} args - Submission arguments.
 * @param {object} args.actor - The acting player.
 * @param {object} args.host - The host, whose socket is watched.
 * @param {string} args.text - The action text.
 * @param {number} args.timeoutMs - How long to wait.
 * @returns {Promise<{kind: string, code?: string}>} `narration`, `rejected`,
 *   `failure`, or `timeout`.
 */
function submitAndSettle({ actor, host, text, timeoutMs }) {
	return new Promise((resolve) => {
		let done = false;
		/**
		 * @description Resolves once and unhooks every listener.
		 * @param {object} value - The outcome.
		 * @returns {void}
		 */
		const finish = (value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			host.socket.off("narration", onNarration);
			actor.socket.off("action:rejected", onRejected);
			resolve(value);
		};
		const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);

		/**
		 * @description Handles a narration frame, ignoring the empty TTS twin.
		 * @param {object} payload - The frame.
		 * @returns {void}
		 */
		function onNarration(payload) {
			const content = (payload?.content || "").trim();
			if (!content) return;                       // the null/204 twin — keep waiting
			if (/LLM unavailable|failed to respond|\[Error/i.test(content)) return finish({ kind: "failure" });
			finish({ kind: "narration" });
		}
		/**
		 * @description Handles a refusal.
		 * @param {object} payload - The frame.
		 * @returns {void}
		 */
		function onRejected(payload) { finish({ kind: "rejected", code: payload?.code ?? null }); }

		host.socket.on("narration", onNarration);
		actor.socket.on("action:rejected", onRejected);
		actor.socket.emit("action:submit", { lobbyId: actor.lobbyId, text });
	});
}
