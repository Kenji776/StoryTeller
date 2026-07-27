# 0005 — TTS becomes pluggable, with a local server as the default provider

**Status:** Accepted (2026-07-27)

## Context

Narration was ElevenLabs and nothing else. `routes/ttsService.js` held the API
key, the chunking rules, the wire format, and the Socket.IO emission in one file,
and `server.js` threaded `ELEVEN_API_KEY` and `ELEVEN_VOICE_ID` through the timer
system, the SFX resolver, and six narration call sites. Every narrated line cost
money, and a lobby could not be run at all without a key.

A self-hosted, OpenAI-compatible speech server is available on the operator's
network at `http://127.0.0.1:8199`. Probing it establishes the shape we have to
accommodate:

| | ElevenLabs | Local server |
|---|---|---|
| Transport | newline-delimited JSON stream | one buffered response |
| Audio | MP3 | PCM WAV, 16-bit mono 24 kHz |
| Timings | per-character alignment | none |
| Speed | network-bound | ~11× realtime, measured |
| Cost | per character | none |

Two of those rows are load-bearing. WAV cannot be fed to MediaSource — no browser
supports it — so the client's existing `addSourceBuffer("audio/mpeg")` pipeline
cannot play local audio at all. And with no alignment data, the word-highlighting
feature would silently disappear on the local provider.

## Decision

TTS is restructured as a provider layer under `server/services/tts/`, mirroring
the adapter pattern [ADR 0002](0002-fetch-based-provider-adapters.md) established
for `services/llm/`: one descriptor per provider, `fetch` injected, a registry as
the only list of what exists.

Providers normalise to a single frame stream — `{type: "audio"}` and
`{type: "alignment"}` — so the emission layer is provider-agnostic. A provider
declares its `audioFormat`, which travels to the browser on `narration:start`;
the client selects a streaming (MediaSource) or buffered (Blob) playback strategy
from it.

The local provider reconstructs word timings from the WAV header duration,
apportioned across words by character count, so highlighting survives.

Provider selection is a per-lobby host setting alongside the narrator voice.
The local server's URL is **not** among those settings: it comes from
`LOCAL_TTS_URL` in the server environment. A new lobby defaults to the local
provider when its `/health` endpoint answers at boot, and falls back to
ElevenLabs when it does not and a key exists.

## Consequences

**Easier.** Running a lobby costs nothing and needs no third-party account.
Adding a third engine (Piper, Kokoro, an OpenAI-compatible gateway) is one file
and one registry line. The narration emitter is now testable against a fake
provider without a network, which it never was. Provider choice is per lobby, so
one host's local server does not constrain another's.

**Harder.** There are now two playback paths in `client/tts.js` to keep working.
Word timings on the local provider are an approximation — a long word is assumed
to take proportionally longer to say, which is only roughly true, and the
highlight drifts within a sentence before re-converging at its end.

**Accepted tradeoffs.** Local audio is uncompressed: 48 KB per second of speech,
against roughly 4 KB for ElevenLabs MP3. A 30-second narration is a 1.5 MB
payload, base64-inflated to 2 MB over the socket. On loopback or a LAN this is
irrelevant; over a WAN it would not be, and that is the point at which this
decision should be revisited. Because the response is buffered rather than
streamed, first-audio latency scales with narration length instead of being
near-constant — at the measured 11× realtime, a 2000-character narration is about
12 seconds of silence before playback starts.

## Alternatives considered

**Transcode WAV to MP3 server-side and keep one client path.** Preserves the
streaming pipeline and shrinks the payload by 10×. Rejected: it requires ffmpeg
or a native encoder as a hard runtime dependency, and the project has no build
step and no native modules today. Revisit if the socket payload becomes a real
constraint.

**Decode PCM in the browser with the Web Audio API and schedule chunks
gaplessly.** True streaming for the local provider, and it would fix the
first-audio latency. Rejected as disproportionate: it means reimplementing the
fade-out, stop, and volume behaviour that `NarrationChannel` already provides
against `HTMLAudioElement`, for a provider that generates 11× faster than
realtime. This is the right fix if latency becomes the complaint.

**Let the host type the local server's URL in the settings window.** Convenient
for pointing at a TTS box elsewhere on the LAN. Rejected: the server, not the
browser, issues the request, so a lobby host could aim it at any address the
server can reach — a server-side request forgery vector opened for a
configuration that changes approximately never. An operator-controlled env var
gives the same reach with none of the exposure.

**Drop ElevenLabs entirely.** Simpler, and the local server is free. Rejected:
the voice quality and the per-character timing data are genuinely better, and
existing lobbies have ElevenLabs voice ids persisted in their state.

_Last verified: 2026-07-27 against branch `Refactor` (dd5c07f)._
