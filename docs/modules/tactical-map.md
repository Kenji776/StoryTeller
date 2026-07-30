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
[tactical-combat.md](tactical-combat.md). Everything below is built and wired into the turn pipeline
behind the toggle, except where a section says otherwise.

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

Two things worth knowing about the plumbing. `state:update` carries the map as well as `tactical:map`
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

## Rendering and the switch

The canvas, the pop-out window, and the setting a host uses to turn any of this on have their own
doc — see [tactical-ui.md](tactical-ui.md). One rule from it belongs here because it constrains the
server: **`tacticalCombat` off must mean nothing happens** — no generation, no prompt block, no
persona menu, no pipeline stage, no window. Not a map that exists and is ignored. The prompt
additions are the dangerous part; a map block injected when the toggle is off would change narration
in every existing game, and do it quietly.

## What exists, and what does not

Built: the geometry ([tactical-geometry.md](tactical-geometry.md)), seeded arena generation, movement
and reach enforcement, and enemy intent on the vocabulary of
[ADR 0027](../decisions/0027-enemies-are-given-intent-not-coordinates.md), narrator-supplied and
re-validated. Rendering and the toggle are covered above; the live probes are `tactical-probe.mjs` and
`menu-payload-probe.mjs`.

Not built: **templates** — cones, cubes and spheres, which is what closes the area-spell gap where an
area spell currently hits one target.

Deliberately out of scope, and each one a rabbit hole: opportunity attacks, flanking bonuses,
elevation, difficult-terrain movement animation, multi-cell creatures beyond a `size` field, and
doors.

_Last verified: 2026-07-30 against branch `Refactor` — phases 1, 2, 4 and 5 are built, switchable from
the game options window, and exercised by the simulation harness. Phase 6 is still design only._
