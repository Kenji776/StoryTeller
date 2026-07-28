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
| `armor` | armor | `ac`, `armor_type` — **the only stat the server computes** |
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

Worth knowing before designing around it:

- **`armor.ac` is live.** `enemyTurns.js` rolls enemy attacks against it.
- **`weapon.damage` is not.** The server never rolls player damage; the weapon
  reaches the model as prompt text and nowhere else. A `+1` sword changes the
  fiction and no number.
- **`trinket` is not.** Same — it is described to the DM and computed by nothing.

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

## Generosity

`lobby.lootGenerosity` (`sparse` | `fair` | `generous`) becomes one sentence of
prompt via `_lootInstruction`. Measured behaviour at `fair`, over 15 real DM
calls: **6/6 loot-seeking turns paid out, and 2/3 still paid out on a failed
roll.** The roll gates access to a container, never the reward inside it. "You
find nothing" is not a state the game can currently reach.

Reproduce with `server/test-integration/loot-probe.mjs`.

## Probes

| Probe | What it answers | Cost |
|---|---|---|
| `test-integration/loot-probe.mjs` | What does the DM hand out, and how often? `--set failed` repeats it on failed rolls. | real DM calls |
| `test-integration/consumable-probe.mjs` | Can a player actually drink a potion, and is the amount applied? | free — no model |

_Last verified: 2026-07-28 against branch `Refactor` (833fcc8)._
