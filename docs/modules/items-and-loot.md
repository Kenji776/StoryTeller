# Items and loot

How a thing gets into a character's bag, what kind of thing it is, and what
happens when they use it.

## The two channels

The Dungeon Master returns treasure through two fields of its JSON reply:

| Field | Applied by | Lands in |
|---|---|---|
| `updates.inventory` | `broadcastInventoryUpdates` | `player.inventory[]` |
| `updates.gold` | `broadcastGoldUpdates` | `player.gold` |

Nothing stops the model using both for the same coins, and it does. A live probe
had one character handed `"Gold Pieces (Goblin Pouch)" ×6` as an item *and* `+6
gold` for the same pouch: the coins banked correctly and the player kept a junk
entry named after the bag, permanently.

`services/lootNormalize.js` sits between the reply and the two broadcasters —
the position `stripResolvedDamage` occupies for the same reason — and reconciles
them. It collapses a currency entry only when it can prove the case:

- a `gold` update already exists for that player → the item is dropped
- no gold update but the amount is unambiguous → the item becomes gold
- neither → **the entry is left exactly as it is**

That last branch is deliberate. Deleting an unquantifiable "Coin Purse" would
silently destroy treasure the DM meant to grant; minting a number for it would
invent treasure it did not.

## Item kinds

`client/itemSlots.js` answers what kind of thing an item is. It is a pure module
so the unit tier can cover it, and `index.html` attaches it to `window` for the
classic scripts — the same bridge `portraitPrompt.js` uses. The server imports it
back across, so client and server cannot disagree about what a potion is.

| `attributes.item_type` | Slot | Notes |
|---|---|---|
| `weapon` | weapon | `damage`, `damage_type`, `range` |
| `armor` | armor | `ac`, `armor_type` |
| `trinket` | trinket | one slot only |
| `consumable` | — | spent, not worn; see below |
| `quest` | — | letters, keys, maps, tokens |

The order of the checks is load-bearing. A stated type wins, *including* the
types meaning "not equipment": an earlier version tested `consumable` after its
name-keyword pass, so an "Orb of Alchemist's Fire" was offered as a trinket
because "orb" is a trinket word.

`quest` exists because the DM produced five story hooks in a single probed
session — a sealed letter, two keys, two maps — all typed as trinkets, against
one trinket slot.

### What is actually mechanical

As of [ADR 0018](../decisions/0018-player-attacks-are-rolled-by-the-server.md):

- **`armor.ac` is live**, through `services/armourClass.js` — light adds full DEX,
  medium caps it at 2, heavy ignores it. Enemies roll against the result.
- **`weapon.damage` is live.** `services/playerAttacks.js` rolls it, doubling the
  dice on a critical hit.
- **`attributes.bonus` is live** on both weapons and armour: it adds to the attack
  roll, to damage, and to AC. A `+2` is worth two.
- **`attributes.bonus_damage` is live** — an affix's extra dice are rolled on a hit
  and not on a miss.
- **`trinket` is still not.** Its effect is described to the DM and computed by
  nothing, so a Ring of the Veil works exactly as well as the narrator remembers it.

## Using a consumable

`item:use` applies the effect server-side. It does **not** cost a turn and does
**not** call the model: using an item is a mechanical act with a known outcome,
and routing it through the narrator meant paying for a generation and hoping it
remembered to emit both the HP update and the inventory removal. It often did
not, which is why potions were inert for so long.

The flow, in `server.js`:

1. the item is spent first — if applying the effect throws, the character has
   still drunk the potion, rather than holding one that heals repeatedly
2. `resolveConsumable` reads the effect: `attributes.healing` (a dice expression
   via `helpers/dice.js`), or the builder's prose form "Restores 2d4 + 2 hit
   points", and `attributes.cures` for conditions
3. HP and conditions go out through the ordinary broadcasters
4. a line is appended to history so the DM narrates around it next turn

`resolveConsumable` is pure and takes its randomness as a parameter, so a
potion's roll can be pinned in a test. Conditions the character does not have are
not reported as cleared — an antitoxin drunk by a healthy character used to
announce it had cured poison.

Condition names are validated against `services/conditions.js`, which the DM
prompt interpolates. Held in two places, the vocabulary drifts and the model
starts naming conditions nothing can apply.

## Where loot comes from

Not from the narrator. See [ADR 0017](../decisions/0017-loot-is-rolled-by-the-server.md)
for why; the short version is that asked whether the party should find something, a
model mid-prose has no way to say no. It paid out on six of six loot-seeking turns,
and on two of three turns where the roll had *failed*.

The turn now runs in this order, mirroring how enemy attacks are already handled:

1. `services/lootMoment.js` reads the player's action and decides whether this is a
   looting turn, and against what — `trash`, `elite` or `boss` (by the challenge
   rating of what lies dead), `cache` (a named container or hoard), or `search`.
2. `services/loot.js` rolls it, **before** the model is called, because the narration
   has to describe the outcome and so the outcome has to exist first.
3. The result goes into the prompt as an authoritative `LOOT THIS TURN` block —
   including, importantly, the case where the answer is nothing.
4. The server applies the items and gold itself. `stripGrantedLoot` drops the model's
   own copy of the same reward, as `stripResolvedDamage` does for damage.

### The odds

| Source | Item | Gold | Rarity bias |
|---|---|---|---|
| `trash` | 7% | 35% | down |
| `search` | 18% | 30% | down |
| `elite` | 33% | 60% | — |
| `cache` | 60% | 75% | up |
| `boss` | 80% | 85% | up |
| `quest` | 100% | 90% | up |

`lootGenerosity` scales these (sparse ×0.5, fair ×1, generous ×1.6). Nothing but a
quest reward is ever certain — the ceiling is 95%, because a chest that always pays
is a formality rather than a moment.

Two pacing corrections sit on top:

- **Drought.** Each turn since the party last found anything adds a point of chance,
  up to 25, so a session cannot go entirely dry.
- **Exhaustion.** Each repeated search of one scene divides the odds, so "I search
  the bodies" typed twenty times is not a gold faucet. It resets when a new
  encounter begins.

### Rarity

Party level caps the tier: below 5 nothing above uncommon, below 9 nothing above
rare, below 13 nothing above very rare. An affix is drawn from the item's own tier
or the one below — without that window the engine produced a *very-rare* "Pendant of
the Wayfinder" whose entire power was knowing which way north is.

The tables live in `server/config/loot-tables.json`, deliberately **not** under
`client/config/`, which is served to the browser. Base items come from the existing
`weapons.json` and `armor.json`.

### What the narrator still owns

Naming the thing and saying where it came from — the part worth reading. It may not
change the item, its rarity, its effect, or the amount of gold, and it is told not to
invent equipment as a reward for searching. Shops, gifts, agreed quest rewards,
consumables and quest items all remain its own.

## Probes

| Probe | What it answers | Cost |
|---|---|---|
| `test-integration/loot-probe.mjs` | Does the DM honour the server's decision? `--force nothing` and `--force treasure` pin the roll so the run measures obedience rather than dice; `--set failed` repeats the scenarios on failed rolls. | real DM calls |
| `test-integration/consumable-probe.mjs` | Can a player actually drink a potion, and is the amount applied? | free — no model |

_Last verified: 2026-07-28 against branch `Refactor` (09eb5fb)._
