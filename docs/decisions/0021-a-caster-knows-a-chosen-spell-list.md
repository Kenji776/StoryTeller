# 0021 — A caster knows a chosen spell list

**Status:** accepted

## Context

Magic was the last part of a turn the narrator decided alone. XP moved to the server in
[ADR 0008](0008-xp-for-kills-is-awarded-by-the-server.md), loot in
[0017](0017-loot-is-rolled-by-the-server.md), attacks in
[0018](0018-player-attacks-are-rolled-by-the-server.md), balance in
[0020](0020-combat-balance-measured-not-guessed.md). Spells did not follow, and the
reason turned out not to be the roll.

**A level-1 caster could not cast a named spell at all.** `classProgression.json` starts
at level 2, so their `abilities` array was empty, and `hardChecks` rejected "I cast magic
missile" as an unknown ability — costing one of the three strikes that end a turn. Only
the vague "I cast a spell" passed, and that reached a flat 15/8 ladder rolling `int`
whatever the class.

Two facts decided the shape of the fix. Of the 115 characters across 61 stored lobbies,
**102 are level 1 and none exceed level 3**; 38 are casters. And of the 28 abilities in
the class table carrying damage or save data, exactly one sits at or below level 3 —
Fireball is level 5. Building resolution on top of the class table would have been
machinery that has never once fired in this game's recorded history.

## Decision

**Add a spell catalogue with structured mechanics, and make knowing a spell a choice.**

`client/config/spells.json` carries levels 0–1 for the six classes that cast from level 1,
with mechanics as typed fields — `resolution`, `damage`, `damageType`, `save`, `onSave` —
never as prose.

A caster picks **three** spells at character creation and **one more per level**, from
anything on their class list at or below their spell level (half character level, rounded
up). Cantrips are at-will; levelled spells spend the existing shared activation pool.

`services/spellbook.js` owns all of it, including the per-class casting ability that
replaces the hardcoded `int`.

## Consequences

**Easier.** A caster has something to do on turn one, and the gate has something to say
yes to without becoming permissive — an off-list spell is still refused. The mechanics a
resolver needs are already typed and rolled-ready, so the resolution phase is arithmetic
rather than parsing. Adding a spell is a JSON entry. The catalogue is under
`client/config/`, so the browser can render a picker from the same file the server rules
on.

**Harder.** There are now two vocabularies of magic — the class table's `abilities` and
this catalogue — and a player at level 5 will hold both. They are resolved separately and
the gate checks abilities first. Merging them is a later decision, deliberately not taken
here.

The catalogue is also a content surface that must grow with the level cap: `maxSpellLevel`
reaches 9 and the data stops at 1, so a level-4 caster's pick list will not widen until
someone writes level-2 spells.

**Accepted risk.** `knownSpells` falls back to a loadout when `player.spells` is absent,
which silently gives 38 existing casters three cantrips they did not choose. The
alternative — leaving them mute until they re-save — is worse, and an empty array is kept
distinct from a missing one so a real choice is never overwritten.

## Alternatives considered

**Parse the class table's `details.damage`.** Rejected. The strings are English:
`"20d10 force on hit; 10d10 in 20-ft radius (DEX save half)"`. Two entries deal damage on
a *successful* save, so a parser that guessed would invert them — the same class of defect
`computeDamage` already guards against for weapons inventing `"1d6+1"`. It would also only
matter above level 5, which nobody has reached.

**Loosen `hardChecks` so unnamed spells escalate to the judge.** Rejected, though it fixes
the insult cheaply. It leaves magic entirely narrated, which is the thing every ADR since
0008 has been removing, and it makes the gate's list of what a character knows a lie.

**Give a caster their whole class list.** Rejected at the operator's direction, and
correctly: a spell list with no choice in it is an inventory, not a character. The pick is
what makes two wizards different.

**Ration cantrips against the activation pool.** Rejected. A level-1 pool is one
activation, so a wizard would get a single Fire Bolt per long rest and be a worse
combatant unarmed.

_Last verified: 2026-07-28 against branch `Refactor` (6a2adfb)._
