# Module: `server/services/tts/`

The provider-agnostic narration layer. Every spoken line in StoryTeller is
synthesised through here; no other module knows which engine produced the audio.

Design rationale is [ADR 0005](../decisions/0005-pluggable-tts-with-a-local-server.md).
The adapter shape deliberately mirrors `services/llm/`
([ADR 0002](../decisions/0002-fetch-based-provider-adapters.md)).

## Layout

| File | Responsibility |
|---|---|
| `wavTiming.js` | Reads a RIFF/WAVE header; approximates word timings from a clip duration. |
| `providers/localServer.js` | Self-hosted OpenAI-compatible server: `/health`, `/voices`, `/v1/audio/speech`. |

The ElevenLabs adapter, the registry, and the emission layer arrive with the
later phases of this work; this document grows with them.

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
