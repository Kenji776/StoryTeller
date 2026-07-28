# 0018 — A player's attack is rolled by the server, against the target's real armour class

Status: accepted

## Context

Half of every fight was already deterministic. [ADR 0008](0008-xp-for-kills-is-awarded-by-the-server.md)
took XP off the narrator, and `enemyTurns.js` took the enemies' attacks: they are
rolled server-side against the player's armour class, with damage by challenge
rating, and `stripResolvedDamage` deletes the model's attempts to re-apply them.

The players' half was never taken. What was there:

- **`autoRollIfNeeded` graded an attack against a flat ladder** — 15 or better is a
  success, 8 or better is "mixed". The armour class stored on every enemy and
  printed into the prompt decided nothing at all. A goblin at AC 15 and an adult
  dragon at AC 19 were exactly as hard to hit.
- **Damage was never rolled.** The model chose a number and `updateEnemies` wrote
  its `hp` field into the roster verbatim.
- **`weapon.damage` reached prompt text and the character sheet UI and nothing
  else.** So the loot engine of [ADR 0017](0017-loot-is-rolled-by-the-server.md) was
  handing out `+1` and `+3` weapons that changed nothing whatsoever.
- **Players had no proficiency bonus.** Enemies get 2–5 from their challenge
  rating; a player got their bare ability modifier, so the party's chance to hit
  stayed flat while its opposition's climbed with every level.

Separately, and worse: **armour made a character easier to hit.** Armour class was
"the number printed on the armour, else 10 + DEX", so a DEX 16 rogue was AC 13
unarmoured and AC 11 in leather — while `armor.json`'s own note for that entry reads
"AC 11 + DEX modifier". It was also computed in two places with different rules, so
the number the advisor quoted a player was not the number the enemies rolled
against.

## Decision

The server rolls the player's attack, and owns the hit points it takes off.

`armourClass.js` is the single armour class: light adds the full dexterity
modifier, medium caps it at 2, heavy ignores it in both directions, unarmoured is
10 + DEX, and the unarmoured value is a floor so an upgrade can never be a
downgrade. `enemyTurns.js` and `characterCapability.js` both call it.

`playerAttacks.js` mirrors `resolveEnemyAttacks` deliberately, down to the injected
dice. It picks a target from the action text — a named enemy wins, otherwise the
most wounded one still standing — then rolls d20 + ability modifier + proficiency +
the weapon's `+N` against that target's actual armour class. A natural 20 is a
critical hit and doubles the weapon's dice; a natural 1 always misses.

`applyEnemyDamage` puts the result into the roster, and `updateEnemies` takes a
`serverResolved` list whose hit points it refuses to touch — the mirror of
`stripResolvedDamage`. XP for a kill is awarded at the point of the killing blow,
because `updateEnemies` never sees that death.

The narrator is handed a `YOUR ATTACK, ALREADY RESOLVED` block, in the same shape as
`ENEMY ACTIONS THIS ROUND`. A miss is stated as firmly as a hit, and grazes,
staggers and other partial successes are forbidden by name.

## Consequences

Armour class matters, on both sides. A `+1` sword and a `+2` breastplate are worth
what they say. The loot engine's output stopped being decorative on the day this
landed.

Players can miss. That was previously close to impossible — the ladder was
generous and the narrator would not refuse a player anyway — and it is the thing
that gives a hit weight. A live run produced two misses in a row against AC 18
hobgoblins, narrated as "your blade goes wide, point burying itself harmlessly in
the air beside his hip", with the target's hit points untouched.

Combat is slower and more attritional, because a level 3 fighter swinging a
shortsword at AC 18 misses more than half the time. That is the correct 5e answer
and it may still be the wrong *game* answer; `difficulty` currently scales encounter
composition and prompt tone but not to-hit maths, and that is where a dial would go.

The narrator loses the ability to decide that a dramatic blow finishes a wounded
foe. It keeps everything about how the blow looks.

Target selection is a heuristic over player text. Naming an enemy is honoured;
otherwise the most wounded is chosen, which is both what a table would do and a
guess. A player who meant the other goblin will be told, in the narration, which one
they hit.

## Alternatives considered

**Leave enemy hit points with the model and pass the roll as a suggestion.**
Rejected. It is the option the evidence argues hardest against: told plainly not to
restate resolved damage, the model restates it — that is why `stripResolvedDamage`
exists, and a live run here confirmed the model still emits its own `enemies` block
on a resolved turn. A suggestion it may override is not determinism.

**Roll the attack but let the DM soften a miss into a graze.** Rejected on the same
grounds, and it was offered to the operator explicitly. The model's bias is toward
letting players succeed; a graze is a hit with extra steps.

**Ask the model for the target rather than parsing the action.** Rejected: the
target must be known *before* the call, because the narration has to describe the
blow. Same ordering constraint as ADR 0017's loot block.

**Full 5e: advantage, cover, reach, opportunity attacks, resistances.** Deferred.
This ADR buys the part that makes equipment mean something. The rest is depth on a
foundation that now exists.

_Last verified: 2026-07-28 against branch `Refactor`._
