---
name: video
description: Make a short video clip through the media tool (Mixdog Media Studio).
when_to_use: 'Generate or extend video, or animate stills; not still-image generation or editing.'
metadata:
  requires: media
dependencies:
  tools:
    - type: tool
      value: media
---

# Video generation (media tool · Media Studio)

Use `media` to generate short video clips; read this guide before the first call. The `media` tool schema and `list` own the controls, lane catalog and sign-in state; nothing here names a lane or a model. A still the clip needs first is the `image` skill's job.

## 1. Which route
**Hard rule — video only when motion was asked for**: a deliverable never gets a clip by default; a still that carries the meaning is not turned into a video.

| Situation | Route |
|---|---|
| a scene whose identity, exact composition, or continuity must survive the motion | **image first**: load the `image` skill and generate a still at the clip's aspect with the protected subjects and environment composed in one picture; inspect it; then generate the video with that file as the reference |
| several separately supplied subjects that must stay recognizable | references-to-video with each identity as its own reference (index and role, identity first), duration at the short end of the model's range |
| continuing an earlier clip | a new job with the previous clip's last frame as the reference (read `references/prompting.md` first); only the pose carries over |
| a pure text-to-video request with no subject to protect | generate directly from the prompt |

**Hard rule — no signed-in lane, no clip**: when `list` (or a failed `generate`) reports no video lane, say so and stop; never substitute a slideshow, a GIF from stock, or a placeholder.
**Default — one generation per job, one corrected retry**: a miss is retried once with a single changed variable and every invariant restated; a second miss is reported, not attempted a third time. Several candidates only when the user asks.

## 2. Call order
1. `media action:'list' kind:'video'` once per session: signed-in lanes, models, and `remembered` — the lane/model a generate runs on when none is passed. Add `model:` for that model's controls; pass a control only when that model lists it.
2. **Hard rule — pick the source in this order**: a source the user names is passed as `lane` (and `model` if named), resolved from `list`; if it is not signed in, say so rather than swap. Otherwise omit `lane`/`model`; the runtime uses the configured default (pinned), else the current Studio selection or last clip's lane/model (remembered), else the signed-in ChatGPT lane if it makes video, else the first signed-in lane, so the clip comes from what the user chose. Choose a lane/model by capability only when the job needs one the selected model lacks (reference count, a duration outside its range).
3. Before writing the prompt, read `references/prompting.md`.
4. `media action:'generate' kind:'video', prompt, path, aspect, duration, resolution, references, wait:true`. Use `wait:false` only when background execution is requested or useful independent work remains. The result reports the lane, model, and `laneSource` (`requested` = a lane explicitly selected in the call (a model alone is not), `pinned` = the user's configured default for video, `remembered` = their last choice, `first` = the default lane or the first available signed-in lane) that actually ran.
5. A background or resumed job: `media action:'status' job:<id> path:<file>` at spaced intervals; the call that sees `done` writes the file. A running job is pending, not completion and not a failure: do not regenerate it or tight-loop status calls; `cancel` only when the user moves on.
6. **Hard rule — look before using**: frame-sample or play the file; check the opening frame, that the one change happens, the ending frame, and that no text, logo, or extra subject appeared.
7. The result is also a Studio asset (`assetId`); the file at `path` is the copy the work uses.

## 3. Prompt and controls
The prompt is an active shot, not a list of elements: labeled items, never keywords or JSON. A detailed user prompt is normalized and nothing is added; a generic one gets only shot design, camera intent, and a concrete environment — never extra characters, props, brands, or story beats. Exclusions: `no text, no logos, no watermarks`; `no faces` only for a field for copy or on request.
- `aspect` from the destination (a feed or story clip `9:16`, an embed or presentation `16:9`, a tile `1:1`), a listed value; the still generated first uses the same aspect.
- `duration` fits the beats and the model's list or range. References beyond one shorten the allowed duration on most models — read the model's controls before promising a length.
- `resolution`: lowest listed for a draft that checks motion and pacing, highest for delivery.
- `references:` take file paths (cap: `maxReferences`): the user's own file, a still from the `image` skill, or an earlier clip's frame — never a downloaded third-party image. Each gets an index and a role in the prompt; identity references (face, product, logo) go first.

## 4. Saving, reporting, provenance
- **Never overwrite**: an existing file gets a sibling (`clip-v2.mp4`) unless replacement was asked; output goes beside the work that uses it or where the user named.
- **Report** the final path, the lane/model that actually ran, duration, resolution, aspect, and the prompt.
- **Declare generated media where it lands** (caption, note, or message) with lane/model and prompt; never present it as footage of a real event, place, or person.

## 5. Failure and cost
A `generate` error carries `lanes` (signed in for video) or `available` (models): choose from it and call again, or stop. Video costs far more credit than a still: one call per job, drafts at low resolution, no speculative variants.

## Resources
`references/prompting.md` — read before constructing a video prompt, and when extending a clip.
