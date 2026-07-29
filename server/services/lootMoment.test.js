/**
 * Tests for loot-moment detection.
 *
 * @description The server has to decide *before* it calls the model whether this turn
 *   is one where treasure could appear, because the reward must be in the prompt for
 *   the narration to describe it. The player's own words are the signal, and they are
 *   unambiguous far more often than not: the probed sessions used "I search the goblin
 *   bodies", "I work the lock on the iron-bound chest", "I look for treasure among the
 *   grave-goods".
 *
 *   The cases below are drawn from those transcripts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { detectLootMoment } from "./lootMoment.js";

/** A slain rabble, as the enemy roster holds them. */
const DEAD_GOBLINS = {
	"Goblin 1": { name: "Goblin 1", status: "dead", cr: "1/4" },
	"Goblin 2": { name: "Goblin 2", status: "dead", cr: "1/4" },
};

/** A slain champion. */
const DEAD_CHIEFTAIN = { Gurnak: { name: "Gurnak", status: "dead", cr: "7" } };

// ── Turns that are not about loot ────────────────────────────────────────────

test("an ordinary action is not a loot moment", () => {
	for (const action of [
		"I swing my shortsword at the nearest goblin.",
		"I ask the innkeeper about the road north.",
		"I cast Light on my holy symbol.",
		"I climb the rope to the ledge above.",
		"I wait and listen.",
	]) {
		assert.equal(detectLootMoment({ action, enemies: DEAD_GOBLINS }), null, `"${action}" was read as looting`);
	}
});

test("searching for something that is not treasure is not a loot moment", () => {
	// The distinction that matters: looking *for* a thing you named is a story beat,
	// not a payout.
	assert.equal(detectLootMoment({ action: "I search the crowd for my brother's face.", enemies: {} }), null);
	assert.equal(detectLootMoment({ action: "I search my memory for the name of the inn.", enemies: {} }), null);
});

test("missing and malformed input is not a loot moment", () => {
	for (const opts of [{}, { action: null }, { action: "" }, { action: 42 }, { action: "   " }]) {
		assert.equal(detectLootMoment(opts), null, `${JSON.stringify(opts)} was read as looting`);
	}
});

// ── Looting the dead ─────────────────────────────────────────────────────────

test("searching bodies after a fight is a loot moment scaled to what died", () => {
	const action = "I search the goblin bodies for anything useful — coin, weapons, anything they were carrying.";

	assert.equal(detectLootMoment({ action, enemies: DEAD_GOBLINS }).source, "trash");
	assert.equal(detectLootMoment({ action, enemies: DEAD_CHIEFTAIN }).source, "boss");
});

test("a mid-tier foe is worth more than rabble and less than a champion", () => {
	const action = "I loot the body.";
	const ogre = { Ogre: { name: "Ogre", status: "dead", cr: "2" } };

	assert.equal(detectLootMoment({ action, enemies: ogre }).source, "elite");
});

test("looting is recognised however the player phrases it", () => {
	for (const action of [
		"I loot the corpses.",
		"I rifle through the dead bandit's pockets.",
		"I strip the fallen of anything valuable.",
		"I scavenge what I can from the remains.",
		"I kneel beside Gurnak's body and take whatever he was carrying.",
	]) {
		assert.ok(detectLootMoment({ action, enemies: DEAD_CHIEFTAIN }), `"${action}" was not read as looting`);
	}
});

test("looting with nothing dead nearby is an ordinary search", () => {
	assert.equal(detectLootMoment({ action: "I search for anything valuable.", enemies: {} }).source, "search");
});

test("enemies still standing are not lootable", () => {
	const alive = { "Goblin 1": { name: "Goblin 1", status: "active", cr: "1/4" } };

	assert.equal(detectLootMoment({ action: "I search the bodies.", enemies: alive }).source, "search");
});

// ── Containers and hoards ────────────────────────────────────────────────────

test("opening a container is a cache, whatever else is in the room", () => {
	// A chest beats a corpse: the player named the more interesting target.
	const action = "I work the lock on the iron-bound chest with my thieves' tools and open it.";

	assert.equal(detectLootMoment({ action, enemies: DEAD_GOBLINS }).source, "cache");
	assert.equal(detectLootMoment({ action, enemies: DEAD_CHIEFTAIN }).source, "cache");
});

test("a hoard is recognised as a cache", () => {
	for (const action of [
		"I look for treasure among the grave-goods.",
		"I pry open the strongbox under the throne.",
		"I open the coffer at the foot of the bier.",
		"I search the hidden cache behind the bookshelf.",
	]) {
		assert.equal(detectLootMoment({ action, enemies: {} })?.source, "cache", `"${action}" was not read as a cache`);
	}
});

test("searching a room is a plain search, not a hoard", () => {
	const action = "I search the study carefully — the desk drawers, behind the books, under the rug — for anything hidden.";

	assert.equal(detectLootMoment({ action, enemies: {} }).source, "search");
});

// ── Boundaries ───────────────────────────────────────────────────────────────

test("an unreadable challenge rating does not promote rabble to a champion", () => {
	const nonsense = { Thing: { name: "Thing", status: "dead", cr: "banana" } };

	assert.equal(detectLootMoment({ action: "I loot the body.", enemies: nonsense }).source, "trash");
});

test("a fractional challenge rating is read as the fraction it is", () => {
	const rat = { Rat: { name: "Rat", status: "dead", cr: "1/8" } };

	assert.equal(detectLootMoment({ action: "I loot the body.", enemies: rat }).source, "trash");
});

test("the strongest of several dead sets the tier", () => {
	const mixed = { ...DEAD_GOBLINS, ...DEAD_CHIEFTAIN };

	assert.equal(detectLootMoment({ action: "I loot the bodies.", enemies: mixed }).source, "boss");
});

test("a missing enemy roster is treated as an empty one", () => {
	assert.equal(detectLootMoment({ action: "I loot the bodies." }).source, "search");
	assert.equal(detectLootMoment({ action: "I loot the bodies.", enemies: null }).source, "search");
});

// ── Quest rewards ────────────────────────────────────────────────────────────
//
// A quest reward is the one loot source the player cannot produce alone. "I hand
// over the amulet to the elder" and "I hand over my sword to the guard" are the
// same sentence; only what the narrator said last turn tells them apart. So the
// detector reads both sides, and fires only when both agree.

/** The narrator putting a reward on the table, in its own voice. */
const OFFER = "<p>Elder Maren turns the amulet over in her hands. 'You have done what none of us could.'"
	+ " She nods to the strongbox by the hearth. 'Your reward, exactly as we agreed.'</p>";

/** A narration with no reward anywhere in it. */
const NO_OFFER = "<p>The market is loud with hawkers and the smell of frying onions."
	+ " Elder Maren is nowhere in sight.</p>";

/**
 * Builds a lobby history whose most recent DM turn is the given narration.
 *
 * @description Shaped as the server actually holds it at the moment the detector runs:
 *   the player's own action has already been appended by `appendUser`, so the DM's
 *   offer is never the last entry, and `appendDM` stores the model's raw JSON reply
 *   rather than the prose inside it.
 * @param {string} narration - What the DM said on its last turn.
 * @param {object} [opts] - Shaping options.
 * @param {boolean} [opts.asJson=true] - Store it as the DM's JSON reply, which is the
 *   form `appendDM` writes. False stores bare prose, which older lobbies hold.
 * @returns {Array<object>} The history.
 */
function historyEndingWith(narration, { asJson = true } = {}) {
	return [
		{ role: "assistant", content: JSON.stringify({ text: "<p>The road bends south through the pines.</p>" }) },
		{ role: "user", name: "Sylvie", content: "I follow the road." },
		{ role: "assistant", content: asJson ? JSON.stringify({ text: narration, music: "calm" }) : narration },
		{ role: "user", name: "Sylvie", content: "I step up to the elder." },
	];
}

test("accepting a reward the narrator just offered is a quest moment", () => {
	for (const action of [
		"I accept the reward.",
		"I take the payment she offers.",
		"I claim the bounty.",
		"I collect our reward and thank her.",
		"I pocket the purse.",
	]) {
		assert.equal(
			detectLootMoment({ action, enemies: {}, history: historyEndingWith(OFFER) })?.source,
			"quest",
			`"${action}" was not read as a quest reward`,
		);
	}
});

test("turning the job in is a quest moment", () => {
	for (const action of [
		"I turn in the quest.",
		"I hand over the amulet to the elder.",
		"I hand the amulet over and wait.",
		"I deliver the sealed letter to the captain.",
		"I complete the contract and step back.",
	]) {
		assert.equal(
			detectLootMoment({ action, enemies: {}, history: historyEndingWith(OFFER) })?.source,
			"quest",
			`"${action}" was not read as a quest reward`,
		);
	}
});

test("the player accepting alone is not a quest reward", () => {
	// The whole point of reading both sides. Without an offer behind it, "I accept the
	// reward" is a player asking for treasure, and a quest roll pays an item every time.
	assert.equal(detectLootMoment({ action: "I accept the reward.", enemies: {}, history: historyEndingWith(NO_OFFER) }), null);
	assert.equal(detectLootMoment({ action: "I accept the reward.", enemies: {} }), null);
	assert.equal(detectLootMoment({ action: "I accept the reward.", enemies: {}, history: [] }), null);
});

test("the narrator offering alone is not a quest reward", () => {
	assert.equal(
		detectLootMoment({ action: "I swing my shortsword at the nearest goblin.", enemies: {}, history: historyEndingWith(OFFER) }),
		null,
	);
	assert.equal(
		detectLootMoment({ action: "I ask the elder what the reward will be.", enemies: {}, history: historyEndingWith(OFFER) }),
		null,
	);
});

test("only the narrator's most recent turn can offer a reward", () => {
	// An offer two turns back has already been accepted or ignored. Scanning further
	// would let one quest reward pay out for the rest of the session.
	const stale = [
		{ role: "assistant", content: JSON.stringify({ text: OFFER }) },
		{ role: "user", name: "Sylvie", content: "I ask her to hold it for me." },
		{ role: "assistant", content: JSON.stringify({ text: NO_OFFER }) },
		{ role: "user", name: "Sylvie", content: "I come back the next morning." },
	];

	assert.equal(detectLootMoment({ action: "I accept the reward.", enemies: {}, history: stale }), null);
});

test("a narration stored as bare prose is read the same as one stored as JSON", () => {
	const asProse = historyEndingWith(OFFER, { asJson: false });

	assert.equal(detectLootMoment({ action: "I accept the reward.", enemies: {}, history: asProse })?.source, "quest");
});

test("an unparseable DM entry is scanned as raw text rather than throwing", () => {
	const truncated = [{ role: "assistant", content: `{"text":"${OFFER}` }];

	assert.equal(detectLootMoment({ action: "I accept the reward.", enemies: {}, history: truncated })?.source, "quest");
});

// ── Quest rewards: what is deliberately refused ──────────────────────────────

test("rewarding yourself is not a quest reward", () => {
	// The operator's own example. Both halves of the reward test pass on this sentence —
	// "reward" is named, "take" is a receiving verb — and it is a drink at a bar.
	assert.equal(
		detectLootMoment({
			action: "I reward myself with a drink and take a room for the night.",
			enemies: {},
			history: historyEndingWith(OFFER),
		}),
		null,
	);
});

test("refusing the reward pays nothing", () => {
	// Every one of these names a reward *and* a receiving verb, so each fires without
	// the refusal guard. A player who says no must not be handed it anyway.
	for (const action of [
		"I refuse to take the reward.",
		"I won't take the payment.",
		"I decline to accept the reward.",
		"I turn down the reward and take my leave.",
	]) {
		assert.equal(
			detectLootMoment({ action, enemies: {}, history: historyEndingWith(OFFER) }),
			null,
			`"${action}" was read as collecting a reward`,
		);
	}
});

test("paying somebody is not being paid", () => {
	for (const action of [
		"I hand over the payment to the smith.",
		"I pay the ferryman for passage.",
	]) {
		assert.equal(
			detectLootMoment({ action, enemies: {}, history: historyEndingWith(OFFER) }),
			null,
			`"${action}" was read as collecting a reward`,
		);
	}

	// This one already reads as an ordinary search — "take" aimed at "gold" — and it
	// must stay one. The failure to guard against is promotion, not the old verdict.
	assert.equal(
		detectLootMoment({ action: "I hand over the gold and take the key.", enemies: {}, history: historyEndingWith(OFFER) }).source,
		"search",
	);
});

test("accepting something that is not a reward is not a quest moment", () => {
	for (const action of [
		"I accept the challenge.",
		"I accept her apology.",
		"I take the seat by the fire.",
		"I return to the tavern to wait for the elder.",
	]) {
		assert.equal(
			detectLootMoment({ action, enemies: {}, history: historyEndingWith(OFFER) }),
			null,
			`"${action}" was read as collecting a reward`,
		);
	}
});

test("going through the dead is looting, whatever the narrator just offered", () => {
	// A corpse pays what the corpse is worth. Letting a reward offer promote it would
	// make every post-fight search after a quest hand-in pay like a quest.
	const action = "I take the purse from the dead bandit's body.";

	assert.equal(
		detectLootMoment({ action, enemies: DEAD_GOBLINS, history: historyEndingWith(OFFER) }).source,
		"trash",
	);
});

test("a named container still outranks a quest reward", () => {
	const action = "I open the strongbox by the hearth and take my reward.";

	assert.equal(detectLootMoment({ action, enemies: {}, history: historyEndingWith(OFFER) }).source, "cache");
});

// ── Quest rewards: boundaries and malformed history ─────────────────────────

test("a history with nothing from the narrator in it cannot offer a reward", () => {
	const playersOnly = [
		{ role: "user", name: "Sylvie", content: "I walk into the hall." },
		{ role: "user", name: "Brannor", content: "I follow her." },
	];

	assert.equal(detectLootMoment({ action: "I accept the reward.", enemies: {}, history: playersOnly }), null);
});

test("an empty last narration cannot offer a reward", () => {
	for (const content of ["", "   ", null, 42, undefined]) {
		assert.equal(
			detectLootMoment({ action: "I accept the reward.", enemies: {}, history: [{ role: "assistant", content }] }),
			null,
			`content ${JSON.stringify(content)} was read as an offer`,
		);
	}
});

test("a malformed history is ignored rather than fatal", () => {
	// The detector runs inside the action handler. Throwing here would cost the player
	// their turn over a history entry nobody will ever look at.
	for (const history of [null, 42, "a string", { role: "assistant" }, [null], [undefined], [{}]]) {
		assert.equal(
			detectLootMoment({ action: "I accept the reward.", enemies: {}, history }),
			null,
			`history ${JSON.stringify(history)} was read as an offer`,
		);
	}
});

test("history does not disturb any of the other sources", () => {
	// The regression guard. Every existing source must classify identically whether or
	// not the narrator happened to mention a reward last turn.
	const history = historyEndingWith(OFFER);

	assert.equal(detectLootMoment({ action: "I loot the corpses.", enemies: DEAD_CHIEFTAIN, history }).source, "boss");
	assert.equal(detectLootMoment({ action: "I search the goblin bodies for coin.", enemies: DEAD_GOBLINS, history }).source, "trash");
	assert.equal(detectLootMoment({ action: "I pry open the coffer.", enemies: {}, history }).source, "cache");
	assert.equal(detectLootMoment({ action: "I search for anything valuable.", enemies: {}, history }).source, "search");
	assert.equal(detectLootMoment({ action: "I search the crowd for my brother's face.", enemies: {}, history }), null);
	assert.equal(detectLootMoment({ action: "I climb the rope to the ledge above.", enemies: {}, history }), null);
});
