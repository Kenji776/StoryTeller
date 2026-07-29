/**
 * balance-sim — can a party actually win?
 *
 * @description Plays thousands of fights through the real resolvers and reports win
 *   rates, so the difficulty dial can be tuned against evidence instead of instinct.
 *   Costs nothing: no model is called, because combat is deterministic now.
 *
 *   It reproduces the server's turn flow, including the share-out that decides which
 *   enemies swing on which player's turn. That detail is the reason this exists — the
 *   first run found every enemy attacking on every player's turn, so a party of three
 *   facing three goblins took nine attacks a round against their three, and Hardcore
 *   was winnable 2% of the time.
 *
 *   The two columns that matter most are `1-shot` and the floor of `win%`. A single
 *   blow must never take a character from full health to dead, and no encounter should
 *   be unwinnable at any setting.
 *
 *     node server/test-integration/balance-sim.mjs
 */

import { resolveEnemyAttacks } from "../services/enemyTurns.js";
import { resolveAttack } from "../services/playerAttacks.js";
import { difficultyModifiers } from "../../client/difficulty.js";

const TRIALS = 4000;

/** A level-appropriate character, roughly what the character builder produces. */
function makeParty(size, level) {
	const hp = level === 1 ? 12 : 8 + level * 6;
	const party = {};
	for (let i = 0; i < size; i++) {
		party[`P${i}`] = {
			name: `P${i}`, level,
			stats: { hp, max_hp: hp, str: 16, dex: 12, con: 14 },
			weapon: { name: "Shortsword", damage: "1d6", damageType: "slashing", range: "melee" },
			armor: { name: "Chain Shirt", ac: 13, type: "medium" },
		};
	}
	return party;
}

/** Enemies as the model typically writes them. */
function makeEnemies(count, cr, hpEach, ac, str, multiplier) {
	const enemies = {};
	for (let i = 0; i < count; i++) {
		const scaled = Math.max(1, Math.round(hpEach * multiplier));
		enemies[`E${i}`] = { name: `E${i}`, hp: scaled, max_hp: scaled, ac, str, cr, status: "active" };
	}
	return enemies;
}

/**
 * One fight, played the way the server plays it.
 * @returns {{won: boolean, rounds: number, worstSingleHit: number, worstPlayerTurn: number, downed: number}}
 */
function fight({ partySize, level, enemyCount, cr, enemyHp, enemyAc, enemyStr, difficulty }) {
	const mods = difficultyModifiers(difficulty);
	const players = makeParty(partySize, level);
	const enemies = makeEnemies(enemyCount, cr, enemyHp, enemyAc, enemyStr, mods.enemyHpMultiplier);

	let worstSingleHit = 0;
	let worstPlayerTurn = 0;
	let downed = 0;
	let rounds = 0;

	const living = (o) => Object.values(o).filter((x) => (x.stats ? x.stats.hp > 0 : x.hp > 0 && x.status === "active"));

	while (living(players).length && living(enemies).length && rounds < 60) {
		rounds++;
		for (const p of Object.values(players)) {
			if (p.stats.hp <= 0) continue;
			if (!living(enemies).length) break;

			// The player's swing.
			const target = living(enemies).sort((a, b) => a.hp - b.hp)[0];
			const atk = resolveAttack({ attacker: p, target, difficulty });
			if (atk?.hit) {
				target.hp = Math.max(0, target.hp - atk.damage);
				if (target.hp === 0) target.status = "dead";
			}

			// The enemies' round — fires on every player action, which is the point.
			//
			// `round` is not optional here even though the resolver tolerates its
			// absence. Without it the resolver falls back to "caller does not know the
			// round, give it the whole roster", and this file silently goes back to
			// measuring the action-economy bug it exists to catch. It did exactly that
			// for one commit.
			if (!living(enemies).length) break;
			const before = Object.fromEntries(Object.values(players).map((x) => [x.name, x.stats.hp]));
			const seats = living(players).length;
			const turn = resolveEnemyAttacks({
				enemies, players, difficulty,
				round: rounds,
				turnIndex: Object.values(players).indexOf(p),
				partySize: seats,
			});
			for (const name of turn.acted) enemies[name].actedInRound = rounds;

			for (const a of turn.attacks) if (a.hit) worstSingleHit = Math.max(worstSingleHit, a.damage);
			for (const [name, dmg] of Object.entries(turn.damage)) {
				worstPlayerTurn = Math.max(worstPlayerTurn, dmg);
				const victim = players[name];
				const wasUp = before[name] > 0;
				victim.stats.hp = Math.max(0, victim.stats.hp - dmg);
				if (wasUp && victim.stats.hp === 0) downed++;
			}
		}
	}

	return { won: living(enemies).length === 0 && living(players).length > 0, rounds, worstSingleHit, worstPlayerTurn, downed };
}

/**
 * @description Runs many fights and summarises them.
 */
function sample(scenario) {
	let wins = 0, oneShots = 0, oneTurnKills = 0, totalRounds = 0;
	const partyHp = scenario.level === 1 ? 12 : 8 + scenario.level * 6;

	for (let i = 0; i < TRIALS; i++) {
		const r = fight(scenario);
		if (r.won) wins++;
		if (r.worstSingleHit >= partyHp) oneShots++;
		if (r.worstPlayerTurn >= partyHp) oneTurnKills++;
		totalRounds += r.rounds;
	}

	return {
		win: (wins / TRIALS * 100).toFixed(1) + "%",
		oneShot: (oneShots / TRIALS * 100).toFixed(1) + "%",
		oneTurn: (oneTurnKills / TRIALS * 100).toFixed(1) + "%",
		rounds: (totalRounds / TRIALS).toFixed(1),
	};
}

const SCENARIOS = [
	{ label: "L1 solo vs 2 goblins (CR 1/4)", partySize: 1, level: 1, enemyCount: 2, cr: "1/4", enemyHp: 7, enemyAc: 15, enemyStr: 8 },
	{ label: "L1 party of 3 vs 3 goblins", partySize: 3, level: 1, enemyCount: 3, cr: "1/4", enemyHp: 7, enemyAc: 15, enemyStr: 8 },
	{ label: "L3 party of 3 vs 2 hobgoblins (CR 1/2)", partySize: 3, level: 3, enemyCount: 2, cr: "1/2", enemyHp: 11, enemyAc: 18, enemyStr: 13 },
	{ label: "L3 party of 3 vs 1 ogre (CR 2)", partySize: 3, level: 3, enemyCount: 1, cr: "2", enemyHp: 59, enemyAc: 11, enemyStr: 19 },
	{ label: "L5 party of 4 vs 4 orcs (CR 1)", partySize: 4, level: 5, enemyCount: 4, cr: "1", enemyHp: 15, enemyAc: 13, enemyStr: 16 },
];

for (const difficulty of ["casual", "standard", "hardcore", "merciless"]) {
	console.log(`\n══ ${difficulty.toUpperCase()} ${"═".repeat(60 - difficulty.length)}`);
	console.log("  scenario                                    win%    1-shot  1-turn  rounds");
	for (const s of SCENARIOS) {
		const r = sample({ ...s, difficulty });
		console.log(`  ${s.label.padEnd(42)} ${r.win.padStart(6)}  ${r.oneShot.padStart(6)}  ${r.oneTurn.padStart(6)}  ${r.rounds.padStart(5)}`);
	}
}

console.log("\n  win%    = party wipes the encounter without losing everyone");
console.log("  1-shot  = a SINGLE enemy attack dealt >= a character's full hit points");
console.log("  1-turn  = one player-turn's worth of enemy attacks did");
