# 0007 — HP is clamped to max_hp at the point of application

Status: accepted

## Context

`applyHPChange` floored HP at zero and had no ceiling. Every other HP write path
already clamped: short rest (`lobbySettings`), long rest (sets HP to the maximum
outright), and both admin repair paths. The omission was on the one path the
Dungeon Master drives.

A 30-turn playtest ended with a level-1 Fighter at 23/12 and a Wizard at 17/12.
Both had healed while already at full health — Orrin spent a Healing Potion at
12/12 and came out five points ahead. From that turn on, the DM was prompted with
hit points above the maximum it was still balancing encounters against, and the
party panel rendered "23 / 12" for the rest of the session.

The model's own JSON carried a `new_total` field, and on the two turns in
question that field was correct (12 in both cases). It was being discarded in
favour of `delta` alone.

## Decision

Clamp inside `applyHPChange`: `Math.min(ceiling, Math.max(0, before + applied))`.

Treat a non-numeric `delta` as no change rather than coercing it. `delta` arrives
from LLM-authored JSON, and `Number("abc")` is `NaN`, which would have been
written to the sheet, persisted to disk, and silently poisoned every later
comparison. This was found by the test matrix for the ceiling, not by the report.

Leave a sheet carrying no usable `max_hp` uncapped rather than inventing one.

Clamp downward as well as upward, so a character inflated by a lobby saved before
this change is normalised by the next HP event rather than staying inflated.

## Consequences

Healing at full health is now a wasted action, as it should be. Damage is
unaffected. Characters in saved lobbies with inflated HP will drop to their
maximum the next time HP changes at all — a visible correction, but the
alternative is leaving them permanently wrong.

The DM is once again prompted with hit points inside the range it reasons about.

## Alternatives considered

**Trust the model's `new_total` instead of applying `delta`.** Rejected. It is
the model's own arithmetic from a base it sometimes misreads: on a third heal in
the same transcript it sent `delta: 5, new_total: 17` while the character was
already at 18, so honouring it would have *reduced* their HP. `new_total` is a
plausibility hint, not an authority.

**Clamp in `gameUpdates` at the broadcast site.** Rejected. It would fix the one
caller and leave the store method still capable of writing out-of-range HP for
the next caller.

**Introduce temporary hit points, making over-maximum HP legitimate.** Rejected
as out of scope: nothing in the schema, the prompt, or the client models temp HP,
so this would have been inventing a mechanic to justify a bug.

_Last verified: 2026-07-27 against branch `Refactor`._
