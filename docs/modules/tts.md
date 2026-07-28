# Module: `server/services/tts/`

The provider-agnostic narration layer. Every spoken line in StoryTeller is
synthesised through here; no other module knows which engine produced the audio.

Design rationale is [ADR 0005](../decisions/0005-pluggable-tts-with-a-local-server.md).
The adapter shape deliberately mirrors `services/llm/`
([ADR 0002](../decisions/0002-fetch-based-provider-adapters.md)).

## Layout

| File | Responsibility |
|---|---|
| `registry.js` | The only list of which providers exist, plus the selection policy. |
| `localConfig.js` | Where the local server lives, and whether we are willing to dial it. |
| `narrate.js` | Turns a provider's frame stream into Socket.IO events. Knows no engine. |
| `wavTiming.js` | Reads a RIFF/WAVE header; approximates word timings from a clip duration. |
| `providers/localServer.js` | Self-hosted OpenAI-compatible server: `/health`, `/voices`, `/v1/audio/speech`. |
| `providers/elevenLabs.js` | ElevenLabs `stream/with-timestamps`, with an on-disk voice cache. |

## How it is wired

`server.js` owns two mutable maps and one resolver:

- `ttsAvailability` — which engines answered the boot probe. The voice routes
  update it when a provider that was down starts answering.
- `ttsDefaultVoice` — per provider; the local server's own declared default is
  learned at boot, ElevenLabs' comes from `ELEVEN_VOICE_ID`.
- `resolveTTS(lobbyId, requestedVoiceId)` — normalises the lobby's stored provider
  against live availability and picks a voice: caller → lobby setting → provider
  default.

`ttsActiveFor(lobbyId)` is derived from the same resolver and injected into the
turn timer, which branches on it: when audio is coming it waits for the client's
`narration:done`, and when it is not it applies a fixed 60-second reading delay.
Before TTS was pluggable this was "is there an ElevenLabs key", which would now
wrongly report silence for a lobby narrating locally.

### HTTP surface

| Route | Answers |
|---|---|
| `GET /api/tts/providers` | Every engine, its format, whether it is reachable, and the default. |
| `GET /api/voices?provider=<id>` | That engine's voices, memoised per provider. |
| `GET /api/voice-preview/:id?provider=<id>` | A spoken sample. 204 in dev mode. |

The boot probe runs once, so both voice routes will ask a provider that is marked
unavailable rather than refusing outright — a container whose network came up late
recovers on the next request instead of needing a restart. An empty voice list is
never memoised, for the same reason.

## Client playback

`client/tts.js` picks one of two strategies from the `format` on `narration:start`:

| Format | Strategy |
|---|---|
| `mpeg` | Chunks are fed to MediaSource as they arrive; playback starts early. |
| anything else | Chunks are collected, then played as one Blob at `narration:audio:end`. |

The buffered path exists because **MediaSource cannot decode WAV in any browser**,
and the local server returns a complete clip rather than a stream, so there is
nothing to stream anyway. Both paths drive an ordinary `HTMLAudioElement`, so
fade-out, stop, and word highlighting are shared.

Every buffered failure — an undecodable clip, a blocked autoplay, a cancelled
stream — calls `_signalDone()`. The turn timer is waiting on `narration:done`, and
would otherwise sit through its three-minute fallback in silence.

### Player voices

A character sheet's `voice_id` is an ElevenLabs id, so it is only used when
ElevenLabs is the active engine. On any other engine a player's spoken line falls
back to the lobby's narrator voice, which means every character sounds like the
DM. Mapping characters onto local voices is not done.

## Emission

`narrate.js` broadcasts four events, and the ordering matters to the client:

| Event | When |
|---|---|
| `narration:start` | Once, before any audio. Carries `speaker`, `streamId`, `format`. |
| `narration:audio` | Zero or more; base64 in `data`. |
| `narration:alignment` | Zero or more; word timings. |
| `narration:audio:end` | Always, exactly once. |

**The end frame is load-bearing.** The client answers it with `narration:done`,
which is what starts the turn timer. Every path through `streamNarrationToClients`
emits one — including dev mode, no configured provider, empty text, a resolver
that throws, and a provider that dies mid-stream. Failing to emit it does not
merely lose audio, it stalls the game. `narrate.js` never rejects, for the same
reason.

When there will be no audio, `narration:start` carries
`status: REJECTED_REQUEST_STATUS` (204) and the client skips straight to done. No
`narration` frame is ever emitted from here: callers have already broadcast the
prose, and a second frame with `content: null` makes the game client print an
empty "DM:" line and the admin feed stringify it to `"null"`.

`streamNarrationToClients` takes a bare `lobbyId` and applies `deps.room` itself.
The previous implementation was called with an already-mapped room *and* mapped it
again; that was invisible only because `room` is currently `(id) => id`.

## Choosing a provider

Selection is per lobby, host-controlled, stored as `ttsProvider` in lobby state.
`normalizeProviderId` is the boundary check: an id that is unknown, or that names a
provider which is no longer reachable, degrades to the default rather than leaving
the lobby mute. A lobby persisted while the local server was running therefore
still narrates after it is switched off.

## Locating the local server

The address is entered by the host in the settings window, tested on demand, and
persisted server-wide to `server/data/tts-config.json`. A saved address beats
`LOCAL_TTS_URL`, which is only a seed for a first run —
[ADR 0006](../decisions/0006-host-configurable-local-tts-address.md) explains why
this reverses ADR 0005's env-var-only decision.

`POST /api/tts/local/url` does the whole flow in one round trip: validate,
resolve, dial, list voices, persist, and mark the engine available. Nothing is
persisted unless the server actually answered with voices — a setting that will
not work on the next restart is not a success and is not reported as one.

**The server dials only private addresses.** `validateLocalTtsUrl` resolves the
hostname and requires *every* returned address to be loopback, RFC1918, CGNAT
(`100.64/10`, which is what Tailscale hands out), or IPv6 unique local. Link-local
is refused, because `169.254.169.254` is where clouds serve instance credentials.
Requiring all resolved addresses rather than any is what stops a name that
resolves to one LAN address and one public address.

Two UI rules follow from this and are easy to break by accident:

- The local engine stays **selectable while disconnected**. Selecting it is how a
  host reaches the address field, so disabling it hides the only way to fix it.
  This was the original defect: an unreachable engine rendered as a disabled
  option with no path forward.
- Changing the address **clears the memoised voice list**. Two speech servers do
  not have the same voices built, and serving the old list would offer names the
  new server rejects as "not built".

## Adapter contract

Every provider exports one descriptor. Adding an engine means writing one file
and adding a line to the registry — nothing else changes.

```js
{
	id, label,                       // identity; `id` is what a lobby persists
	audioFormat,                     // "mpeg" (streamable) | "wav" (buffered)
	isAvailable(deps),               // boot probe; resolves false, never throws
	listVoices(deps),                // → [{id, name, category, accent, description, isDefault}]
	synthesize(text, voiceId, deps), // async generator of frames
	preview(voiceId, deps),          // → {contentType, body}
}
```

`synthesize` yields a normalised frame stream:

- `{type: "audio", data: Buffer}` — one or more, in playback order
- `{type: "alignment", words: [{word, start, end, index}]}` — optional

Frames are capped at `AUDIO_FRAME_BYTES` (64 KB). Socket.IO's default
`maxHttpBufferSize` is 1 MB and frames are base64-encoded on the way out, so an
unsplit 1.5 MB clip would be dropped by the transport rather than played.

`fetchImpl` is a dependency on every method, which is what makes the adapters
testable without a network.

## Word alignment across providers

The client highlights the word currently being spoken by matching the `index` on
an alignment entry against a `data-word-idx` span emitted by `wrapNarrationWords`
in `client/app.js`. That function does **not** wrap bracketed stage directions,
because they are never spoken.

Any provider's alignment must therefore index the same token sequence: split on
whitespace, with `[...]` spans removed first. `estimateWordTimings` enforces this
by doing the bracket strip itself, so the invariant holds regardless of whether
the caller stripped first. Breaking this alignment does not fail loudly — the
highlight simply lands on the wrong word.

## The local provider

Targets the Python server on `LOCAL_TTS_URL` (default `http://127.0.0.1:8199`).

It returns a complete PCM WAV and no timing data, so `synthesize` recovers the
exact duration from the WAV header and spreads it across the words in proportion
to their character count. This is an approximation and is documented as such in
ADR 0005; it tracks well enough to follow prose.

Degradation is deliberately asymmetric: a response whose WAV header cannot be
parsed still yields its audio and simply omits the alignment frame. Losing the
highlight is cosmetic, losing the narration is not.

Failure modes worth knowing:

- Unknown voice → HTTP 500 `{"ok": false, "error": "voice 'X' not built"}`. The
  message is surfaced verbatim; it is more useful than the status code.
- The server is `BaseHTTP` and single-threaded, so a preview request issued while
  a narration is synthesising will queue behind it.
- Requests carry a wall-clock ceiling (120 s synthesis, 5 s probe). A wedged
  model would otherwise hang narration, and with it the turn timer that waits on
  `narration:done`.

_Last verified: 2026-07-27 against branch `Refactor` (dd5c07f)._
