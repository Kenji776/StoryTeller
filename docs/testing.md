# Testing

The project uses Node's built-in test runner (`node:test` + `node:assert/strict`).
It was chosen over Vitest to avoid adding a dependency tree to a project that has
no build step — see the Project Overrides table in `CLAUDE.md`.

## Tiers

| Tier | Command | Contents |
|---|---|---|
| Unit | `npm test` | No I/O, no network, no clock. Everything under `server/` **and `client/`** matching `*.test.js`. |
| Integration | `npm run test:integration` | Real network or filesystem. Lives in `server/test-integration/`, which is created when the first such test is written. |
| Coverage | `npm run coverage` | Unit tier with `--experimental-test-coverage`. |

The unit tier is excluded from any real network access by construction: modules
that make HTTP requests take `fetchImpl` as a parameter, and tests pass a fake.
The integration directory is deliberately outside the unit runner's discovery
path (`*.itest.js` and `test-integration/` are both invisible to `node --test
server/`), so a missing credential can never break the default suite.

Browser code is in the unit tier only where it is free of the DOM. A test under
`client/` runs in Node with no `document`, so a module that reaches for one cannot
be covered — which is the constraint that shapes `client/admin/`: state, routing,
formatting and permissions are pure modules, and the DOM is confined to the layer
that renders them.

## Conventions

- Test files sit beside the code they cover: `config.js` → `config.test.js`.
- Test names state the behaviour, not the mechanics —
  `normalizeLLMConfig rejects a malformed base URL`, not `test normalize 3`.
- Fixtures and helper builders carry Javadoc blocks; individual cases do not need
  them, because the name is the specification.
- Credentials in tests are obviously fake: `test-key-DO-NOT-USE`. No test, at any
  tier, may read a real key from the environment and fail without it.
- Injected dependencies over module-level globals. `fetch` and the clock are
  parameters so that tests are deterministic and order-independent.

## What is deliberately untested

The pre-existing codebase has no tests. Rather than retrofit them wholesale, the
policy is: **new and changed units are developed test-first; untouched legacy
code is left as it is until it is modified.**

Not covered as of this writing:

- `server/server.js`, `server/routes/*`, `server/services/lobby*` — the existing
  game loop and lobby state. Large, I/O-coupled, and not yet refactored for
  injection.
- **Rendering.** There is still no DOM test harness; adding one would mean the
  dependency this project has so far avoided. The admin panel works around this
  rather than accepting it: its logic lives in dependency-free modules under
  `client/admin/core/`, which the unit tier covers in full, while the section
  modules stay thin render functions over tested selectors. What that leaves
  unverified is the rendering itself — that an element is built, placed and wired
  to the right handler — which is checked by hand.
- Real provider calls. Every adapter is unit-tested against a fake `fetch`, which
  pins request construction and response parsing but cannot catch a provider
  changing its API. That gap is what the integration tier is for — and it is now
  partly closed for TTS: `test-integration/localTts.test.js` narrates through a
  real local server and asserts the emitted frames reassemble into a playable WAV
  whose alignment indices match the spans the client wraps. It **skips** rather
  than fails when no server answers on `LOCAL_TTS_URL`, so the tier stays runnable
  without one.
- The two client narration playback paths. `client/tts.js` chooses between
  MediaSource streaming and buffered Blob playback based on the provider's format;
  only the server half of that contract is covered. Verified by hand instead.

_Last verified: 2026-07-27 against branch `Refactor` (97d037d)._
