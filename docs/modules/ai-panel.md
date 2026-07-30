# Module: `client/aiPanel.js`

The browser side of AI configuration: the readiness rows, the Start gate, the
narrator model picker, and turning a form into a credential submission.

It decides nothing. The server's verdict is presented, never re-derived —
`services/credentials/readiness.js` produces it and `routes/aiSetup.js` enforces
it, both covered in [`credentials.md`](credentials.md). A second opinion in the
browser is how a Start button ends up enabled for a game the server will refuse.

The logic lives here, apart from the markup, because `options.html` is one long
inline script with no test harness — everything that could be got wrong is in a
file that can be tested.

## Two rules that are easy to get wrong

- **Unknown means not startable.** Before the first `ai:state` arrives there is no
  verdict, and defaulting to enabled lets someone press a button the server then
  refuses — which reads as a broken game rather than as missing configuration.
- **A date input means the end of that day.** A host choosing "the 5th" wants the
  key to last *through* the 5th; treating it as midnight would expire it as that
  day begins.

## `modelChoices` reads each option's own `ready`, never the service's `providerId`

Where a provider's key comes from is decided per option:

| Condition | Reads as |
|---|---|
| `held.chat.providerId` names it | the host's own key |
| `ready` is false | needs a key — offered, not hidden |
| `ready`, and `requiresApiKey === false` | local, no key needed |
| `ready` otherwise | this server's key |

The order matters and is tested. `openai-compatible` reports `requiresApiKey:
false` — it is whatever endpoint it is pointed at — while `ready` stays false
until one is configured, so readiness has to be answered first or the panel
offers a provider that cannot be reached.

The tempting shortcut is the service-level `chat.providerId`, and it is wrong:
`readiness.js` sets it with `providers.find((p) => p.ready)`, so it names the
*first* provider that could serve, not the one a given lobby uses. Reading it
marked Anthropic as needing a key on a server that had been narrating on
Anthropic all day, and disabled Apply for the provider in use. Every unit test
passed while it did, because the fixture omitted `ready` — the one field the bug
turned on. `server/test-integration/model-picker-probe.mjs` exists for that
reason: it feeds the picker a live `ai:state` and checks that whatever the server
reports as ready is selectable.

A provider with no key anywhere is still listed, flagged and unselectable. Hiding
it would leave a host unable to discover that supplying their own key is
possible, which is most of the panel's purpose.

The model in force is always offered, even when the shipped catalogue has never
heard of it. Otherwise opening the panel and pressing Apply would silently
downgrade a host who had set something newer than the list — which is how a
stale list turns from unhelpful into destructive.

## The bridge is checked by a test, because forgetting it is silent

This is a module and the page scripts are classic, so the functions cross that
boundary through a hand-written `window.__aiPanel = { … }` in `index.html` and
`options.html`. Attaching it beats duplicating it — duplication is exactly the
drift that lets the Start button disagree with the server.

The cost is that a name missing from that object is `undefined` at the call site,
and every call site guards and returns. A feature with passing tests and a
working renderer then simply never appears. That has hidden work four times in
this project, most recently this picker: `index.html` built the bridge without
`modelChoices`.

`client/aiPanelBridge.test.js` reads the pages as text — the only way to inspect
a seam built out of a dynamic global — and fails when a page's scripts call a
bridge name it does not expose, or when it exposes a name this module does not
export. `renderNarratorPanel` also logs to the console rather than returning
quietly, so a blank panel explains itself.

_Last verified: 2026-07-29 against branch `Refactor`._
