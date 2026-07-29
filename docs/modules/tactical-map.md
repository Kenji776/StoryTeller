# Tactical map

Where everyone is standing, when the lobby asks for that to matter.

Off unless `tacticalCombat` is on. The decision and the rejected alternatives are
[ADR 0026](../decisions/0026-tactical-combat-happens-on-a-grid.md); this is the shape of
the thing.

## The two audiences

The map serves two models with opposite needs, and conflating them is the design mistake to
avoid.

**The narrator needs prose anchors.** It is writing a paragraph, and "Dorn at D6" is not
narratable. It gets landmark names — *beside the altar*, *in the doorway* — with coordinates
attached, and it is told the layout is settled.

**The player agents need a decision, not a puzzle.** They get their options with the
geometry already resolved. This is the load-bearing choice in the whole feature: a small
model handed a grid will assert that a target is in range because that is the sentence it
wanted to write. It must never be in a position to be wrong about distance.

## Data model

Stored on the lobby under `map`, regenerated per encounter and persisted with everything
else. Sparse rather than a dense cell array — a 16×12 dense grid is 192 mostly-empty
entries to serialise, log and diff.

```js
map: {
    seed: 8814,                     // generation is reproducible; see Determinism
    width: 16, height: 12,          // cells, not feet
    feetPerCell: 5,
    archetype: "crypt",
    features: [
        { id: "f1", kind: "pillar", cells: [[5, 4]] },
        { id: "f2", kind: "low_wall", cells: [[8, 2], [8, 3], [8, 4]] },
    ],
    landmarks: [
        { name: "the altar", cells: [[7, 6], [8, 6]] },
        { name: "the collapsed stair", cells: [[0, 9]] },
    ],
    tokens: {
        "Dorn Hammerfall": { faction: "party",  cell: [3, 6], size: 1, speedFeet: 25, reachFeet: 5 },
        "Ghoul 1":         { faction: "enemy",  cell: [12, 7], size: 1, speedFeet: 30, reachFeet: 5 },
    },
}
```

Coordinates are `[x, y]` in storage and `D7` in prose — column letter, row number. Numbers
compute; labels narrate. One conversion, at the edge.

### Feature kinds

Each kind is a fixed tuple of three mechanical properties. Adding a kind means adding a row,
never a branch elsewhere.

| kind | movement | sight | cover |
|---|---|---|---|
| `wall` | blocked | blocked | full |
| `pillar` | blocked | blocked | half |
| `low_wall` | blocked | clear | half |
| `rubble` | costs double | clear | none |
| `water` | costs double | clear | none |
| `pit` | blocked | clear | none |

`landmarks` carry **no mechanics at all**. They exist so the narrator has something to name,
and so a player can say "the altar" instead of "G6". Keeping them mechanically inert is what
stops the narration layer from quietly acquiring rules.

## What the server computes

All pure functions over a map and two cells — no I/O, no clock, no randomness. This is the
whole tactical rulebook, and it is unit-testable in isolation.

- `distanceFeet(a, b)` — Chebyshev on cells × `feetPerCell`. Diagonals cost the same as
  orthogonals, which is 5e's own simplification and avoids the every-other-diagonal rule
  that nobody remembers correctly.
- `hasLineOfSight(map, a, b)` — supercover line walk; blocked by any `blocked`-sight cell.
- `coverBetween(map, attacker, target)` — the best cover the target enjoys against that
  attacker: `none | half | full`. Half is +2 AC, full cannot be targeted directly.
- `reachableCells(map, token)` — flood fill bounded by the movement budget, respecting
  blocked cells, doubled costs, and cells occupied by other tokens.
- `pathTo(map, token, cell)` — the route, so movement can be animated and so "you cannot get
  there" can say why.
- `cellsInTemplate(map, origin, shape)` — cone, sphere, cube, line. This is what finally lets
  Burning Hands hit what it says it hits.

Movement speed is a new sheet field, `speedFeet`, defaulting to 30 with 25 for the
traditionally shorter races. Budget in cells is `speedFeet / feetPerCell`.

## The turn, with the map on

The existing sequence gains one stage at the front and one constraint in the middle:

```
gate → MOVE → resolveAttack / resolveSpell → damage → enemy round → loot → prompt → DM
              ▲                ▲                        ▲
              │                │                        └─ enemies move, then target by
              │                │                           proximity rather than round-robin
              │                └─ out of reach or no line of sight now fails as a settled
              │                   fact, instead of the narrator deciding
              └─ validated against reachableCells; an illegal move is refused, not clamped
```

An action carries an optional destination: `action:submit` gains `move: [x, y]`. A browser
sets it by clicking the map. An agent names a cell in its sentence, and the cell is
extracted — reliable precisely because the agent was offered that cell by name in its menu.

Refusing an illegal move rather than clamping it matters. Clamping produces a character
standing somewhere nobody chose, which is the class of silent wrongness this project keeps
removing.

**Proximity targeting is the point.** Replacing round-robin is what makes a front line real:
stand between the ghoul and the cleric and the ghoul attacks *you*, because you are nearer —
guarding as a consequence of geometry rather than a special rule for it. Nothing else in this
feature changes how combat feels as much as this line does.

## What each model is told

**The narrator** gets positions as settled fact, in landmark terms with cells attached, and
is told plainly not to move anyone — the same instruction that already keeps it off enemy
hit points. Movement that happened this turn is described *to* it, so the prose can carry it.

**An acting player** gets a menu, precomputed:

```
You are at D6, behind a pillar — half cover, AC 16 → 18 against anything ranged.
Movement: 5 cells (25 feet).
In reach now:            Ghoul 1 (5 ft).
In reach if you move:    Ghoul 2 — move to G7 (3 cells); Skeleton — move to J5 (5 cells).
In spell range, in sight: Ghoul 1, Ghoul 2, Skeleton.
Not in sight:            Ghoul 3 — the pillar at F5 blocks it.
Cover you could reach:   H8 (half, 4 cells).
Allies:                  Sister Almath at C5 on 7 hp, 1 cell away. Ghoul 2 is 4 cells from her.
```

Every line is an answer, not a question. The agent picks; it never measures.

## Generation

An arena appears when an encounter starts and enemies exist. Size follows party and enemy
count; the archetype follows the scene the narrator has already established — a corridor
reads differently from a crypt — with the narrator allowed to *hint* an archetype and never
required to.

Two invariants, both learned from other people's roguelikes:

- **Every enemy must be reachable from every party spawn.** Generation runs a connectivity
  check and rerolls on failure. A softlock is worse than a boring room.
- **No spawn adjacent to an enemy** unless the encounter is deliberately an ambush, and then
  it says so.

### Determinism

Generation takes an injected RNG seeded from `map.seed`, and the seed is persisted. Three
reasons, and the first is a project rule: `TDD-8` forbids unseeded randomness in anything
tested. The second is that a lobby reloaded from disk must produce the same room. The third
is that a bad arena can be reported, reproduced and fixed by seed.

## Rendering

A separate window at `/map/:lobbyId`, opened from the game view, subscribing to `map:update`.
Canvas over a JSON snapshot; no new dependency.

Kept out of the main document deliberately — the toggle has to be able to change nothing
about the existing UI, and a panel wired into the game view would not be.

Observers see it too. It is the shared state of a fight, not a personal sheet — the same
reasoning that keeps the action log visible to watchers.

## Toggle discipline

`tacticalCombat` off must mean *nothing happens*: no generation, no prompt block, no persona
menu, no pipeline stage, no window. Not a map that exists and is ignored — every one of
those is a conditional at the call site, and the feature is only safe to ship while the
off path is byte-identical to today's.

The corollary is that the prompt additions are the dangerous part. A map block injected when
the toggle is off would change narration in every existing game, and it would do it quietly.

## Phases

Each phase ends green, committed, and useful on its own.

1. **Geometry.** The pure functions above, with tests. Wired to nothing.
2. **Generation.** Seeded arenas, archetypes, the connectivity invariant, persistence.
3. **Visualisation, read-only.** The window renders a generated arena. Combat still abstract.
   The first point at which the idea can be *looked at*, which is when this project's
   defects have historically surfaced.
4. **Movement and enforcement.** The pipeline stage, reach and range as settled facts,
   behind the toggle.
5. **Proximity targeting.** Enemies move and choose by distance. Where the feature earns
   itself.
6. **Templates.** Cones, cubes and spheres; closes the area-spell gap.

Deliberately out of scope for now, and each one is a rabbit hole: opportunity attacks,
flanking bonuses, elevation, difficult-terrain movement animation, multi-cell creatures
beyond a `size` field, and doors.

_Last verified: 2026-07-29 against branch `feature/tactical-map` (3332e68) — design only,
nothing implemented._
