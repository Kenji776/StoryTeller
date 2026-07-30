# Module: the battle map in the browser

How the tactical arena reaches a player and what they can do with it. The grid
itself, what the server computes, and what the narrator is told are in
[tactical-map.md](tactical-map.md); the geometry is in
[tactical-geometry.md](tactical-geometry.md).

Files: `client/tacticalMap.js` (the view model, tested), `client/battleMapWindow.js`
(when the window opens, tested), `drawTacticalMap` in `client/uiComponents.js` (the
canvas), `client/components/battlemap.html` (the pop-out), and the switch in
`client/components/options.html`.

## Rendering

A canvas over a JSON snapshot; no new dependency. Observers see it too: it is the shared state of a
fight, not a personal sheet, the same reasoning that keeps the action log visible to watchers.

**One renderer, two mount points.** `drawTacticalMap` takes the document to draw into. The game view
has `#tacticalMapSection`; `components/battlemap.html` has the same ids and gets drawn into by the page
that opened it. Two canvases fed by two copies of the drawing code would eventually disagree about
which square is which, and the click handler belongs to whichever copy drew last — so there is one
copy, pointed at two documents. The pop-out therefore opens no socket of its own and holds no arena.

The window opens when a fight starts and closes when it ends. The rules are in
`client/battleMapWindow.js` and unit tested, because the failure mode is behavioural: a player who
closes the window is left alone **for that fight**, since map pushes arrive several times a turn and
reopening on each would fight them for control of their own screen. The next fight is a fresh start —
a choice about one encounter is not a standing preference, which is what the setting is for.

**A blocked popup costs nothing.** Combat starting is the server's doing, so `window.open` happens
outside a user gesture and a browser may refuse it. The in-page section therefore stays, and the
Battlefield heading carries a **Pop out map** button — a real click, never blocked.

`tactical:map` carries the arena, **not** `map:update` — that name belongs to the older map feature in
`services/mapService.js`, and sharing it meant sharing the room and losing the player's pending click.
`services/tactical/channel.test.js` explains the collision and holds the two apart.

## Toggle discipline

`tacticalCombat` off must mean *nothing happens*: no generation, no prompt block, no persona
menu, no pipeline stage, no window. Not a map that exists and is ignored — every one of
those is a conditional at the call site, and the feature is only safe to ship while the
off path is byte-identical to today's.

The corollary is that the prompt additions are the dangerous part. A map block injected when
the toggle is off would change narration in every existing game, and it would do it quietly.

The switch lives in the game options window under **Combat Style**, alongside the explanation of what
each choice costs — a host picking this is choosing what kind of fight they want, not enabling a
nicety. Safe to change between fights: the server deletes the arena when it is switched off, so no
orphan map is persisted. `publicState` carries the flag, so the lobby's settings summary shows every
player which kind of combat they are in, not just the host who chose it.

For most of this feature's life that switch did not exist. The server accepted `tacticalCombat` from
the day it was built and no page ever sent it, so the only ways in were `battle-sim.mjs --tactical`
and hand-editing a lobby's JSON. `client/settingsWiring.test.js` now fails when `lobby:settings`
accepts a setting nothing sends.


_Last verified: 2026-07-30 against branch `feature/tactical-map`._
