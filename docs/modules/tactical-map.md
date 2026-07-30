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
never a branch elsewhere. `obstructs` means the shot is still available, at that feature's cover —
only a wall denies it outright. See [tactical-geometry.md](tactical-geometry.md) for why a pillar
is not `blocked`.

| kind | movement | sight | cover |
|---|---|---|---|
| `wall` | blocked | blocked | full |
| `pillar` | blocked | obstructs | half |
| `low_wall` | blocked | clear | half |
| `rubble` | costs double | clear | none |
| `water` | costs double | clear | none |
| `pit` | blocked | clear | none |

`landmarks` carry **no mechanics at all**. They exist so the narrator has something to name,
and so a player can say "the altar" instead of "G6". Keeping them mechanically inert is what
stops the narration layer from quietly acquiring rules.

## What the server computes

The spatial rulebook and the generator are [tactical-geometry.md](tactical-geometry.md); the session
that owns a lobby's map, the briefings and the monsters' tactics are
[tactical-combat.md](tactical-combat.md). Phases 1, 2, 4 and 5 are built and wired into the turn
pipeline behind the toggle, and playable in a browser.

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

### Choosing a move, in a browser

✅ Built. On your turn the reachable squares are tinted green — faintly, so the room still reads as a
room — and clicking one sets the destination. Clicking it again, or the square you already stand on,
cancels. The tint is the whole legality conversation: an illegal move is not refused with a message,
it is simply never offered.

**The browser computes none of it.** The squares arrive on `tactical:menu` beside the text menu the
agents read, held to the same rule for the same reason — one authority on distance, and it is not the
client. A page working out its own reach would eventually disagree with the server about a legal move,
and the player would watch a click be refused for no visible reason. Server validation stays
regardless: an agent names a square in a sentence, and neither input is trusted.

The section sits beside the action log rather than in the character panel, because a battlefield is
shared state — an observer sees the map, and gets no tint because `tactical:menu` only reaches the
character on the clock.

Two things worth knowing about the plumbing. `state:update` carries the map as well as `map:update`
does, so reloading mid-fight or joining one in progress draws immediately rather than after the next
move. And a redundant map push must **not** discard a pending click: `state:update` fires several
times a turn, and treating each as a new arena silently wiped the square the player had just chosen,
so their move never rode along with the action they typed afterwards. Only a genuinely different room
clears it.

### Who moves the monsters

The narrator picks an **intent** — one of `close`, `hold`, `ranged`, `seek_cover`, `withdraw`,
`regroup` — and never a cell; the server turns it into a route. Every enemy has a deterministic
default, so a fight never depends on a working language model. Reasoning and rejected alternatives:
[ADR 0027](../decisions/0027-enemies-are-given-intent-not-coordinates.md), whose test is **if two
competent Dungeon Masters could reasonably disagree, the model decides; if they would both reach for
a tape measure, the server does.**

## What each model is told

**The narrator** gets positions as settled fact, in landmark terms with cells attached, and
is told plainly not to move anyone — the same instruction that already keeps it off enemy
hit points. Movement that happened this turn is described *to* it, so the prose can carry it.

**An acting player** gets a menu in which every line is an answer rather than a question — where they
stand, what cover it gives, what is in reach now, and which square to move to for what is not. The
agent picks; it never measures. The real thing, and what rendering it caught, is in
[tactical-combat.md](tactical-combat.md).

## Generation

An arena appears when an encounter starts and enemies exist. Its size follows the head count and
its archetype follows the scene the narrator has already established — which the narrator may
*hint* and is never required to. The invariants it guarantees, the determinism it depends on, and
what measuring it caught are in [tactical-geometry.md](tactical-geometry.md).

## Rendering

A separate window at `/map/:lobbyId`, opened from the game view, subscribing to `map:update`.
Canvas over a JSON snapshot; no new dependency. Kept out of the main document deliberately —
the toggle has to change nothing about the existing UI, and a panel wired into the game view
would not. Observers see it too: it is the shared state of a fight, not a personal sheet, the
same reasoning that keeps the action log visible to watchers.

## Toggle discipline

`tacticalCombat` off must mean *nothing happens*: no generation, no prompt block, no persona
menu, no pipeline stage, no window. Not a map that exists and is ignored — every one of
those is a conditional at the call site, and the feature is only safe to ship while the
off path is byte-identical to today's.

The corollary is that the prompt additions are the dangerous part. A map block injected when
the toggle is off would change narration in every existing game, and it would do it quietly.

## Phases

Each phase ends green, committed, and useful on its own.

1. **Geometry.** ✅ Done — [tactical-geometry.md](tactical-geometry.md). Pure, and knows nothing
   about a lobby.
2. **Generation.** ✅ Done — seeded arenas, archetypes as data, the connectivity invariant. Persistence lands with the pipeline in phase 4.
3. **Visualisation, read-only.** The window renders a generated arena. Combat still abstract.
   The first point at which the idea can be *looked at*, which is when this project's
   defects have historically surfaced.
4. **Movement and enforcement.** ✅ Done, both halves. Reach and range refuse as settled facts; the
   reachable squares are tinted and clickable. Covered live by `tactical-probe.mjs` and
   `menu-payload-probe.mjs`.
5. **Proximity targeting and enemy intent.** ✅ Done — `enemyTactics.js`. Enemies close on the
   nearest character and cannot strike from out of reach, on the intent vocabulary of
   [ADR 0027](../decisions/0027-enemies-are-given-intent-not-coordinates.md). The narrator-supplied
   order is accepted and re-validated; wiring it into the DM reply is the remaining piece.
6. **Templates.** Cones, cubes and spheres; closes the area-spell gap.

Deliberately out of scope for now, and each one is a rabbit hole: opportunity attacks,
flanking bonuses, elevation, difficult-terrain movement animation, multi-cell creatures
beyond a `size` field, and doors.

_Last verified: 2026-07-29 against branch `feature/tactical-map` — phases 1, 2, 4 and 5 built, wired
and playable in a browser. Phase 6 is still design only._
