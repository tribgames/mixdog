---
name: video
description: Use when a video clip is to be made — a short product or scene clip, a social feed clip, an animated still, a continuation of an earlier clip — through the media tool (Mixdog Media Studio). Carries the route choice (image first, references, continuation), the active-shot prompt, pacing by duration, controls, polling a long job, inspection, saving, and provenance. Load before the first media call for a video; a still image is the image skill.
metadata:
  requires: media
---

# Video generation (media tool · Media Studio)

This file owns the judgement around one tool for moving pictures. It is not tied to any deliverable. The lane catalog (providers, models, controls, sign-in state) lives in the runtime and is read with `list`; nothing here names a lane or a model. A still that the clip needs first is the `image` skill's job — load it for that step.

## 1. Which route
**Hard rule — video only when motion was asked for**: a deliverable never gets a clip by default; a still that carries the meaning is not turned into a video. → manual
| Situation | Route |
|---|---|
| a scene with one or more subjects and an environment | **image first**: load the `image` skill and generate a still at the clip's aspect with every subject and the environment composed in that one picture; inspect it; then generate the video with that file as the single reference. The video model animates a concrete anchor far better than it invents one |
| several separately supplied subjects that must stay recognizable | references-to-video with each identity as its own reference (index and role, identity first), duration at the short end of the model's range |
| continuing an earlier clip | a new job with the previous clip's last frame as the reference; only the pose carries over — motion, trajectory, and camera do not |
| a pure text-to-video request with no subject to protect | generate directly from the prompt |
**Hard rule — no signed-in lane, no clip**: when `list` (or a failed `generate`) reports no video lane, say so and stop; never substitute a slideshow, a GIF from stock, or a placeholder. → manual
**Default — one generation per job, one corrected retry**: a miss is retried once with a single changed variable and every invariant restated; a second miss is reported, not attempted a third time. Several candidates only when the user asks.

## 2. Call order
1. `media action:'list' kind:'video'` once per session: signed-in lanes, models, and each model's controls (`aspectRatio`, `resolution`, `durations` or `durationRange`, `maxReferences`). Add `model:` for one model's controls.
2. `media action:'generate' kind:'video', prompt, path, lane, model, aspect, duration, resolution, references, wait:false` — lane and model from `list`, controls only from that model's list. The result returns a job id.
3. Continue other work; `media action:'status' job:<id> path:<file>` when the file is needed — it is written on the call that sees `done`. Minutes are normal. `cancel` when the user moves on.
4. **Hard rule — look before using**: frame-sample or play the file; check the opening frame, that the one change happens, the ending frame, and that no text, logo, or extra subject appeared. → manual
5. The result is also a Studio asset (`assetId`); the file at `path` is the copy the work uses.

## 3. Prompt — an active shot, not a list of elements
**Hard rule — the prompt names, in this order**: → manual
1. *Shot design*: the opening frame, one motivated reveal or change, and a settling final frame.
2. *Camera intent*: the move that serves the scene — macro push-in for a product, orbit for space, handheld for documentary, crane for scale, static when nothing needs to move. Never a default "slow dolly in".
3. *Production*: concrete material and texture, a motivated light source, depth layers (foreground / mid / background), lens framing.
4. *Sound*: music style, no music, room tone, or effects only.
5. *Dialogue*: the exact line in its original language, or "no dialogue".
6. *Ending frame*: final pose, camera state, last sound cue — clear enough to be the first frame of a next clip.
Each item is one focused sentence or two, labeled; never keywords, never JSON.
**Hard rule — pacing follows duration**: 1-4 s one action; 5-7 s setup, turn, hold; 8-10 s two connected beats; 11-15 s a three-beat arc. Pick the duration from the model's list to fit the beats, not the other way round. → manual
**Hard rule — no slop words**: "cinematic", "volumetric lighting", "neon glow", "AAA trailer", "shot on RED", and unmotivated dark or moody defaults are rejected; write what the camera actually sees. → manual
**Default — specificity policy**: a detailed user prompt is normalized into the six items and nothing is added; a generic one gets shot design, camera intent, and a concrete environment — never extra characters, props, brand names, or story beats.
**Default — exclusions**: `no text, no logos, no watermarks`; `no faces` only when the clip is a field for copy or the user asked for none.

## 4. Controls
- `aspect` from the destination: a feed or story clip `9:16`, an embed or presentation `16:9`, a tile `1:1`; the still generated first uses the same aspect. The value must be one the model lists.
- `duration` from the pacing rule; within the model's list or range.
- `resolution`: the lowest listed for a draft that checks motion and pacing, the highest listed for delivery.
- References beyond one shorten the allowed duration on most models — read the model's controls before promising a length.

## 5. Reference images
`references:` takes file paths; the model's `maxReferences` caps them. A reference is the user's own file, a still from the `image` skill, or an earlier clip's frame — never a downloaded third-party image.
**Hard rule — each reference gets an index and a role in the prompt**: `Image 1: the scene to animate. Image 2: subject identity.` followed by the relationship. Identity references (a face, a product, a logo) go first. → manual

## 6. Saving, reporting, provenance
**Hard rule — never overwrite**: an existing file gets a sibling (`clip-v2.mp4`) unless the user asked for replacement; output goes beside the work that uses it or where the user named. → manual
**Hard rule — the report names what was made**: final path, lane/model (the one that actually ran, when the runtime reports a fallback), duration, resolution, aspect, and the prompt. → manual
**Hard rule — generated media is declared where it lands**: a caption, a note, or the message says the clip is generated, with lane/model and prompt; it is never presented as footage of a real event, place, or person. → manual

## 7. Failure and cost
- A `generate` error carries `lanes` (what is signed in for video) or `available` (models); choose from it and call again, or stop.
- Video costs far more credit than a still: one call per job, drafts at low resolution, no speculative variants.
- A job that is still running past the tool's wait is not a failure; keep polling `status`, and `cancel` only when the user moves on.
