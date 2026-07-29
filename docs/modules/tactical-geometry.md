# Tactical geometry

The spatial rulebook: how far, can it be seen, does it shelter, can I get there.

Phases 1, 2 and 4a of the tactical map ([ADR 0026](../decisions/0026-tactical-combat-happens-on-a-grid.md)).
The feature it serves is [tactical-map.md](tactical-map.md). **Nothing imports this yet** —
that is deliberate, and `grep -rn "tactical/" server/ client/` outside the directory itself
returning nothing is the check.

Six modules under `server/services/tactical/`, one directory so the whole feature can be deleted
rather than unpicked:

| module | one sentence |
|---|---|
| `grid.js` | cells, labels, distance, and what occupies a square |
| `sight.js` | what can be seen from where, and what shelters it |
| `movement.js` | where a token can get to, and by what route |
| `random.js` | a random source you can ask for the same answers twice |
| `arena.js` | laying out a room to fight in |
| `session.js` | a lobby's map: when it exists, who is on it, what it allows |

## The computed facts

All pure functions over a map and two cells — no I/O, no clock, no randomness. This is the
whole tactical rulebook, and it is unit-testable in isolation.

**Phase 1 is built** — `grid.js`, `sight.js` and `movement.js`, 83 tests, imported by nothing.

- `distanceFeet` / `distanceCells` — Chebyshev, so a diagonal costs what an orthogonal does.
  5e's own simplification, and it avoids the every-other-diagonal rule nobody applies
  consistently. `movement.js` charges the same way: the distance a player is quoted has to be
  the distance they pay, or the menu lies.
- `cellsOnLine(from, to)` — the cells a centre-to-centre segment touches, endpoints excluded,
  nearest first. Integer-only: coordinates are doubled once so centres become whole numbers,
  which means no float, no rounding-dependent tie-break, same answer on every machine.
- `hasLineOfSight(map, a, b)` — nothing opaque in between. Neighbours always see each other,
  overriding the corner rule below; being unable to see a creature you stand beside is absurd.
- `coverBetween(map, attacker, target)` — `none | half | full`, from the line crossed **and**
  from scenery beside the target on the attacker's side. Full is also what a blocked line
  reports, so a caller reads one answer rather than a modifier plus an untargetable flag.
- `reachableCells(map, token)` / `pathTo` / `canReach` — Dijkstra, since rubble makes the
  cheapest route differ from the shortest. Both public questions run the **same** search:
  they were two near-identical loops until `npx fallow` called it a clone, and it was right
  about the risk — a squeeze-rule fix applied to one would leave `canReach` and `pathTo`
  disagreeing about which moves are legal.
- `cellsInTemplate(map, origin, shape)` — cone, sphere, cube, line. Deferred to phase 6 with
  the wiring that needs it.

### Three rules the implementation had to settle

- **A diagonal clips both neighbouring cells.** Sight does not pass through the joint between
  two diagonally-placed pillars. Genuinely ambiguous in the source material; this is the
  conservative reading, chosen out loud rather than falling out of an epsilon.
- **Cover from beside is capped at half.** A pillar blocks sight, so its half cover can never
  be earned by a line *through* it — that is no shot at all. It has to come from standing
  beside it, on the attacker's side, which is what "behind a pillar" means to a player. The
  cap is why a wall beside you shelters you without making you untargetable.
- **An enemy is a wall; a friend is a turnstile.** Squeeze past an ally, never stop on one.
  Treating allies as solid would let a party seal itself into a corridor — a softlock wearing
  the costume of a rule.

Movement speed is a new sheet field, `speedFeet`, defaulting to 30 with 25 for the
traditionally shorter races. A token present but silent about speed gets the default rather
than zero: every character in a stored lobby predates the field, and reading that as "cannot
move" would pin the existing cast to the spot.

## Why these are pure

No I/O, no clock, no randomness, no knowledge of combat. Two payoffs. They are unit-testable
in isolation, which is why phase 1 could land with 83 tests and no wiring at all. And they
are the only place a spatial question is ever answered — the narrator is told the results and
a player agent is handed them precomputed, so neither is ever in a position to be wrong about
distance.

## Reading a failure

`mapFixtures.js` is test-only and hand-drawn, with the arena diagrammed in a comment at the
top of each test file. Every assertion in this directory can be checked by eye against that
diagram, which is how two authoring mistakes were caught during phase 1 — both times the
expectation was wrong and the code was right:

- A cover test placed the attacker so that a low wall sat directly between it and the target,
  and asserted no cover. Half cover was correct.
- A path test asserted 15 feet around the wall at C2–C3 where the answer is 20. Provable
  rather than observed: reaching D3 needs three columns of travel, so a three-step route must
  cross column C exactly once, and the wall occupies the only two rows such a route could use.

Worth stating because the alternative — adjusting an assertion to match what the code printed
— is what `TDD-5` forbids, and the difference is whether the new number can be derived
independently.

## Generation

`arena.js` takes who is fighting and returns the room, reproducibly from a seed. Two
invariants are checked before an arena is returned rather than hoped for, and both are worth
more than any amount of interesting scenery:

- **Everyone is in one walkable region.** A party that cannot reach the enemy has a softlock,
  and no in-game action gets them out of it. A boring room is strictly better.
- **Nobody starts in melee** unless an ambush was asked for, because the first enemy round
  landing before anyone has chosen anything reads as the engine cheating.

Both hold structurally rather than by luck. Spawn zones sit at opposite ends and scenery is
never placed in them, so separation falls out of the layout; and the connectivity check thins
the scenery on each retry until, at zero, an empty room is connected by construction.
Generation cannot fail to return a playable arena — which matters, because it is called with a
fight already under way.

Archetypes are **data**: `aspect`, `density`, a weighted `palette`, and some landmark names.
Adding a room type is a row in the table and no new branch anywhere.

### What looking at it caught

Every test passed on the first draft and the output was useless. An 8×7 crypt came out with
**two pillars in it** — connected, nobody in melee, and nothing whatsoever to take cover
behind, which is the entire point of the feature. `density` was being applied to the middle
ground alone, and the middle is only a few columns wide.

The count is now a fraction of the whole arena while placement stays in the middle, with a
floor of three so even the smallest room has cover and a ceiling of 45% of the middle so it
never becomes a maze. Rooms went from 2 features to 8–11.

Rendering the arenas as ASCII is what showed it. No assertion would have: "is this room fun"
is not a property, and the honest check was to draw six of them and look.

## The session layer

`session.js` is the single door everything behind the toggle goes through, so the turn pipeline
gets one conditional rather than a dozen. **With `tacticalCombat` off it writes no field at all** —
not a map that is generated and then ignored, which is a different thing and not a safe one.

Its two mechanical promises both refuse rather than approximate:

- `applyMove` rejects an over-long move instead of trimming it, because a clamped move puts a
  character where nobody chose. The refusal says what the move *would* have cost.
- `reachCheck` makes reach, line of sight and cover into settled facts handed to the resolver,
  and returns cover as a number an attack roll can use directly.

Two translations live here and nowhere else. Speed comes from race — 25 feet for the
traditionally shorter races, 30 otherwise — because no sheet in any stored lobby has a speed
field. And `RANGE_FEET` turns the spell catalogue's range *words* into distances, since
`spells.json` says `touch` and `ranged` rather than numbers. An unrecognised word falls back to
reach rather than to something generous: a spell whose range nobody has heard of must not quietly
become a sniper rifle.

The arena is seeded from the lobby id plus the names of the opposition, which buys two properties
without storing a counter — a reload lays out the same room, and a new encounter against different
enemies lays out a different one.

_Last verified: 2026-07-29 against branch `feature/tactical-map` — phases 1, 2 and 4a complete,
173 tests._
