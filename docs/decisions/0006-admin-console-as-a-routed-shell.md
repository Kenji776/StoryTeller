# 6. The admin panel becomes a routed shell with a tested logic core

Date: 2026-07-27

Status: Accepted

## Context

The admin panel was one page: `admin.html` at 829 lines with all its styling
inline, and `admin.js` at 894 lines in a single flat scope. Every capability was
on that page at once — lobby browser, player table, ten `<details>` accordions of
per-player forms, DM tools, and, inside a tab called "Event Feed", the incident
list and the manual repairs.

Three problems were structural rather than cosmetic:

- **The urgent was the least reachable.** Incidents and repairs — where you go
  when a game is broken — were two levels inside a log viewer.
- **The same value had two homes.** `hp:update` takes a delta and lives under
  Player Events; `hp:set` takes an absolute value and lived under Repairs. Fixing
  a wrong number meant knowing which tab held the arithmetic you needed, and
  retyping the character's name into a free-text box to get there.
- **Nothing was testable.** The panel had no tests and could not have any: every
  decision it made — which role sees what, whose turn it is, how a repair field is
  typed — was interleaved with DOM calls. Two defects had survived in it
  indefinitely as a result (see Consequences).

The project has no build step and no framework, deliberately, and no DOM test
harness — a dependency it has avoided since the first test was written.

## Decision

Rebuild the panel as a routed shell over a tested logic core.

**Logic moves out of the DOM rather than a harness being added.** Everything under
`client/admin/core/` — state, routing, permissions, selectors, feed formatting,
repair coercion, the model catalogue — is dependency-free ESM with no `document`
reference, covered by the existing Node runner. `npm test` gained `client/`.
Section modules stay thin render functions over tested selectors, and `ui/dom.js`
is the only file permitted to touch the DOM outside a section's own tree.

**Sections are declared once** in `nav.js`, grouped by intent — run a game, fix a
game, inspect a game — and routed by hash, so a section is linkable and survives a
reload.

**Roles are declarative.** `core/capabilities.js` maps a role to a capability set
and the shell renders from it. This is presentation only; `isSocketAdmin()` in
`server/routes/adminEvents.js` remains the authorisation boundary and is unchanged.

**The player inspector puts Adjust beside Set.** The absolute-value column is built
from the server's repair catalogue with the character already chosen, so it cannot
drift from what the server offers and the name cannot be mistyped.

## Consequences

**Easier.** Adding a section is one `nav.js` entry plus one renderer. Adding a
server-side repair needs no console change at all — it appears in both the
inspector and Health. A rule about who may see what is a line in a table, checked
by a test, rather than a `remove()` call in a bootstrap.

**Verified where it was not.** Writing the tests immediately surfaced three latent
defects that had been shipping: the Turn and Round indicators were reading
`initiative.current` and `.round` on what is an array with a separate `turnIndex`,
so Turn showed `--` and Round showed `1` for the life of every campaign;
`conditions:set` could never be sent an empty list, so conditions could not be
cleared through the interface its own catalogue note described; and equipment
grants silently replaced a malformed damage expression with `1d6`. A fourth,
`#/lobby//party` resolving to a lobby named `PARTY`, was caught by a router test in
code written the same day.

**Harder.** Rendering is still unverified by any automated test — that a component
is built, placed and wired to the right handler is checked by hand. Three defects
found on first opening the console in a browser (a stale `.boot` class centring the
whole shell, the Adjust/Set grid never fitting two tracks, and `element.hidden`
losing to `display: flex`) are the shape of what this misses. The gap is recorded
in `docs/testing.md` rather than papered over.

**More files.** Roughly thirty small modules where there were two large ones. That
is the trade for each being readable and testable on its own.

## Alternatives considered

**Add a DOM harness (jsdom or linkedom) and test the rendering.** Rejected: it is
the dependency this project has consistently declined, it would not have caught any
of the three defects the browser found — all three are CSS cascade and layout, which
jsdom does not compute — and the logic worth testing can be tested without it.

**Adopt a small framework (Preact or lit via CDN).** Rejected: it breaks the "plain
ESM loaded directly by the browser" invariant in `architecture.md`, needs a
supply-chain review, and buys reactivity that `store.watch` already provides at the
granularity the sections actually need.

**Keep one page and reorganise it in place.** Rejected: the page's problem is that
everything is present at once, which is what makes it unnavigable. Reordering the
same twenty controls does not change that, and leaves the code untestable.

**A separate slimmer page for the host/DM view.** Rejected: two shells to keep in
step, for a difference that is entirely "which sections are visible" — which a
capability set expresses in one table.
