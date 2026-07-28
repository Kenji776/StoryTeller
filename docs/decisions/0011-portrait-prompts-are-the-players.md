# 0011 — The portrait prompt belongs to the player

Status: accepted

## Context

Character portraits had stopped working entirely. The call hardcoded `dall-e-3` and
passed `response_format: "b64_json"`; that endpoint now rejects the parameter, so
every generation failed with `400 Unknown parameter: 'response_format'`. The
gpt-image family does not accept it at all — it always returns base64.

Two further complaints stood behind that one. Images that had worked came back with
words printed on them, lifted out of the prompt. And the prompt used seven of the
sheet's fields — race, class, gender, age, height, weight, description — ignoring
everything the character is visibly wearing and holding, so a plate-armoured knight
and a robed wizard of the same race produced much the same picture.

Probing the deployment's own key: `gpt-image-2` answered in 22s, `gpt-image-1.5` in
38s, `gpt-image-1` in 36s, `dall-e-3` failed. Listing a model is not the same as
being allowed to call it — access is granted per organisation — so the difference
only shows up on a real request.

## Decision

**Pick the best model that answers, and remember it.** `IMAGE_MODELS` is tried in
descending order of capability and the first that succeeds is cached for the
process. A model withdrawn or refusing mid-session falls through to the next rather
than failing the feature.

**The prompt is a first-class, editable thing.** `buildPortraitPrompt(sheet)` builds
a readable description from the whole sheet — including armour, weapon and trinket,
build inferred from ability scores, and background and alignment as bearing. It
fills a textarea under the portrait, which the player may rewrite freely. Whatever is
in that box when they press generate is what is sent.

The box stops auto-refilling the moment they type in it. Overwriting a description
someone wrote by hand because they later changed their armour would be worse than
letting the two fall out of step; a reset button hands it back.

**The builder is shared, not duplicated.** It is an ES module under `client/`,
imported directly by the server and bridged into the classic browser scripts by a
small shim in `index.html`. The text the player edits must be the text that is sent,
and two implementations would drift.

**Text is fought by subtraction.** The character's name never enters the prompt — a
proper noun is the most reliable way to get a name plate or signature painted in —
and it is stripped from the free description too, where players write it without
thinking. The guard appended to every prompt stays abstract: naming things like
"no scrolls with writing" invites the model to draw the scroll.

## Consequences

Portraits work again, on a materially better model, and the picture now reflects
what the character is actually carrying.

Players can direct the image ("in an epic pose", "a battered leather jacket") without
touching their sheet. A verification run produced a dwarf in chain mail holding a
warhammer, holy symbol at his chest, scarred and red-bearded, in the requested
jacket, with no text anywhere.

The guard is appended even to a prompt the player rewrote entirely. They own the
description; they do not own that clause, because they asked for pictures without
writing on them.

Cost per portrait is higher than dall-e-3 was. Not measured here.

## Alternatives considered

**Keep `dall-e-3` and drop the offending parameter.** Rejected: it fixes the crash
and keeps the older model, and the operator asked for the most capable one available.

**Build the prompt server-side and send it down for editing.** Rejected. The box
should fill in as the character is built, which means a round trip per keystroke or
a duplicate implementation in the browser. Sharing one module avoids both.

**Let the player's text be sent verbatim, guard included or not.** Rejected. The
complaint that started this was text appearing on images; a prompt someone pasted
over would silently lose the only defence against it.

**Strip text from generated images afterwards.** Rejected as disproportionate: it
needs OCR and inpainting to fix something the prompt can largely prevent.

_Last verified: 2026-07-27 against branch `Refactor`._
