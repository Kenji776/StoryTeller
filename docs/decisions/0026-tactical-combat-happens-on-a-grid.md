# 0026 — Tactical combat happens on a server-owned grid

**Status:** Proposed (2026-07-29) — branch `feature/tactical-map`, off by default

## Context

Combat has no space in it. There is nowhere to stand, so there is nothing to stand
*behind*, nothing to stand *between*, and no such thing as being out of reach. Three
things follow, and all three were watched happening:

**Cover, guarding and range are unimplementable, not merely missing.** A player cannot take
cover because cover is a spatial relationship and there is no space. The same holds for
screening a wounded ally or backing out of a melee.

**Round-robin targeting makes armour a private matter.** `enemyTurns.js` deals attacks out
evenly across everyone standing, so a wizard in AC 11 robes takes exactly as many swings as
the fighter beside them. This is not an oversight — with no positions, dealing attacks
evenly is the only defensible rule available, since any other choice would be the engine
picking favourites. But it means a party cannot protect anybody, and it is why the
min/max party from 2026-07-29 is four characters in identical chain mail: with no front
line, the only correct build is one where everyone is equally armoured.

**Area spells hit one target.** Recorded as a known gap in
[spell-resolution.md](../modules/spell-resolution.md): Burning Hands names a 15-foot cone
and Thunderwave a cube, and the resolver rolls one save for the chosen target because a cone
has nothing to enclose.

So the map is not a visualisation feature with tactics as a bonus. It is a *targeting*
feature, and the picture is how a player reads it. Building the graphic without changing
enemy target selection would produce a decoration.

## Decision

Positions live on a **square grid of 5-foot cells, generated per encounter and owned
entirely by the server**, behind a lobby setting that is **off by default**.

Two commitments make this safe, and they are the same commitment applied to two different
models:

**The narrator is told where everyone is; it never decides.** Positions, distances, line of
sight and cover are computed and handed over as settled fact, exactly as hit points, attack
rolls and loot already are (ADR 0008 → 0020). A DM that may reposition a creature in prose
is a second source of truth about the one thing the map exists to own.

**The player agents are handed a menu, never a geometry problem.** Each acting character
receives its legal moves and their consequences already computed — what is in reach from
here, what would be in reach after moving, which cells give cover, who is closest to the
wounded cleric. `gpt-4o-mini` cannot reliably decide whether F7 is within 30 feet of C4, and
asking it to would produce confident nonsense at exactly the moment a player is deciding
whether they die. Precomputing the options is the same discipline as precomputing damage.

Full design, data model and prompt shapes: [tactical-map.md](../modules/tactical-map.md).

## Consequences

**What this makes possible.** Cover, screening an ally, reach, ranged versus melee
positioning, retreating, and area templates — each becomes a computed fact rather than
something the narrator may or may not honour. Enemy targeting can become
proximity-based, which is what makes a front line mean anything and what makes armour
class a party-level decision instead of a private one. It also closes the area-spell gap
rather than working around it.

**What this costs.** Every combat turn carries a map block into the prompt, and a second
block into each persona's brief — real tokens on every turn of every fight. The turn
pipeline gains a movement phase before resolution, which is the first change to that
sequence since attacks became deterministic. Arena generation is a new kind of content, and
a bad arena is worse than no arena: a party that spawns with no path to the enemy has a
softlock, not a hard fight.

**What it risks.** The narrator describing a charge across a room the map says is a corridor
— mitigated by stripping and by telling it the layout, but the failure will be *prose that
contradicts the picture*, which is more visible to a player than a wrong number. And the
feature can only be judged live: three sessions of this project's history say a rendered
view finds defects that no unit test does.

**Why off by default.** The abstract game works and people are playing it. A toggle that
adds nothing to the prompt, generates no map and touches no pipeline stage when off is the
only version of this feature that cannot regress what already exists. It is also the only
honest position given the feature may simply not be fun — text combat with a grid may read
as bookkeeping rather than tactics, and that is not knowable from here.

## Alternatives considered

**Named zones instead of a grid** — "the doorway", "behind the pillars", "the far bank",
with adjacency between zones. Far cheaper in tokens, far more natural for a narrator, and
it needs no movement speed. Rejected as the primary model because it cannot answer the
questions that motivated the feature: a zone has no distances, so reach, range and area
templates stay unimplementable and the area-spell gap stays open. Zones are, however, how
the grid gets *narrated* — see the landmark layer in the module doc, which is this
alternative kept for the job it is good at.

**Free-form coordinates with no grid.** More precise and more work: continuous distance
needs no snapping, but pathfinding, cover and templates all get harder, and nothing in a
text game benefits from sub-5-foot precision.

**Hex grid.** Better movement geometry — no diagonal problem. Rejected because every
participant, human and model, has to reason about it in prose, and "two hexes north-east"
is worse for a narrator than "D4". The diagonal problem is a rounding rule; unfamiliarity
is a tax on every turn.

**Let the narrator own positions and merely draw what it says.** Cheapest by far, and it is
what a naive implementation looks like. Rejected on the whole weight of this project's
history: every fact the model was trusted with — enemy hit points, whether a blow landed,
what loot was found, whether a spell was cast — was eventually taken away from it and
computed, because it drifted. Positions would drift faster, since nothing constrains them.

_Last verified: 2026-07-29 against branch `feature/tactical-map` (3332e68)._
