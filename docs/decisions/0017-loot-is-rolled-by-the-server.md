# 0017 — What the party finds is rolled by the server, not decided by the narrator

Status: accepted

## Context

Loot was entirely at the Dungeon Master's discretion. One sentence of prompt —
`_lootInstruction`, selected by the lobby's `lootGenerosity` — and two open
channels, `updates.inventory` and `updates.gold`.

A probe of fifteen real DM calls (`test-integration/loot-probe.mjs`) measured what
that produced:

- **Six of six** loot-seeking turns paid out. On a *failed* roll, two of three
  still paid out. The dice gated access to a container and never the reward
  inside it. "You find nothing" was not a state the game could reach.
- Of seventeen items, **none had a mechanical effect**. No armour dropped at all —
  and armour is the only equipment the server computes, since `enemyTurns.js`
  rolls attacks against `player.armor.ac`. The weapons were 1d6 sidegrades of what
  the party already carried; one arrived with an invented `"damage": "1d6+1"`.
- Eight of seventeen were typed `trinket` — letters, keys, maps — against a single
  trinket slot.
- Coins arrived through both channels at once, so a player banked the gold and kept
  a junk inventory entry named after the bag.

This is the mirror of [ADR 0008](0008-xp-for-kills-is-awarded-by-the-server.md).
There, the narrator never volunteered XP and levelling was unreachable. Here it
volunteers loot every single time and scarcity is unreachable. Both are the same
failure: a model mid-prose is not a bookkeeper, and it is not a random number
generator. Asked "should they find something?", it has no way to say no.

## Decision

The server rolls the loot. The narrator is handed the answer and writes it.

`services/lootMoment.js` decides from the player's own words whether this turn is
one where treasure could appear, and against what — a slain rabble, a champion, a
forced chest, an ordinary search. `services/loot.js` then rolls it: a drop chance
per source, a rarity tier capped by party level, and a mechanically valid item
built from the existing weapon and armour catalogues plus an affix table.

The roll happens **before** the model is called, and the result goes into the
prompt as a `LOOT THIS TURN` block — the same shape as the `ENEMY ACTIONS THIS
ROUND` block that already works. The server then applies the items and gold
itself, and `stripGrantedLoot` drops the model's own copy, exactly as
`stripResolvedDamage` drops its duplicate damage.

The narrator keeps what it is genuinely good at: naming the thing, and saying
where it came from. It loses only the decisions it was bad at — whether, and how
good.

## Consequences

Scarcity is now real and tunable. `lootGenerosity` scales an actual probability
instead of a mood. A trash corpse yields an item about 7% of the time; a boss
about 80%; nothing is ever certain except a quest reward. Repeated searching of
one scene pays progressively less, and a long drought raises the odds, so a
session can be neither a faucet nor a desert.

Items are mechanically real. An armour bonus is folded into the `ac` field the
combat code actually reads. Rarity means something: an affix is drawn from the
item's own tier or the one below, so a legendary cannot carry an uncommon's power.

The detection is a heuristic over player text, and it will miss. Both mistakes are
cheap: a missed roll is a turn where nothing is found, which is the common case
anyway, and a spurious roll usually finds nothing either.

**The engine only fires on turns the detector recognises.** Everywhere else the
old behaviour remains, so the prompt now also forbids inventing weapons, armour
and trinkets as a reward for searching, while explicitly still allowing shops,
gifts and agreed quest rewards. That is an instruction, not a mechanism, and this
document is on record that instructions are the weaker tool. A live run found it
held — zero conjured items across five loot turns, against a hand axe and a potion
conjured on the same scenario before it — but it is the seam to watch.

Weapon damage still is not rolled by the server, so a `+1` sword changes the
fiction and not a number. The engine emits the bonus as a separate `bonus`
attribute rather than splicing it into the damage string, so a future change that
starts rolling player attacks can read it without a migration.

## Alternatives considered

**Strengthen the prompt.** Rejected as the primary fix, for the reason ADR 0008
rejected it: the instruction was already there and the model overrode it every
turn. It survives as the secondary guard described above, where no deterministic
signal exists.

**Let the DM declare the loot moment in its reply, then roll.** Rejected. The
narration and the updates come back in one response, so the roll would land after
the prose was written and the item could only be bolted on by a second call —
paying twice for a worse result.

**Let the server pick only the rarity and have the DM invent the item.** Rejected.
It keeps more of the model's flavour, but the stats stay unvalidated, and
unvalidated stats are where `"damage": "1d6+1"` came from.

**A curated table of hand-written magic items.** Rejected as the starting point:
it produces better individual items and far fewer of them, and repeats become
obvious in a single campaign. Base × affix gives breadth now, and the affix table
is a config file the operator can extend toward curation.

_Last verified: 2026-07-28 against branch `Refactor`._
