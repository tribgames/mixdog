---
name: image
description: Make or edit an image through the media tool (Mixdog Media Studio).
when_to_use: 'Generate or edit still images and assets; not video clips.'
metadata:
  requires: media
dependencies:
  tools:
    - type: tool
      value: media
---

# Image generation and editing (media tool · Media Studio)

Use `media` for still-image generation and editing; read this guide before the first call.

The `media` tool schema and `list` own the controls, lane catalog and sign-in state; this file owns how a picture is asked for, checked, and saved.

## 1. Which kind of job
**Hard rule — generate or edit, decided first**:
- *Generate* — a new image (product shot, hero, social card, illustration, icon, texture, concept), or a deliverable needs one. Images attached only as style, mood, or composition guidance still make this a generate with references.
- *Edit* — an existing image is kept and part of it changed: background swap, object removal, lighting or weather, text replacement, style transfer, compositing, cutout. The source goes in `references` as the edit target.

**Hard rule — not this tool**: a repository's own SVG, icon, or logo system; simple shapes, wireframes, and diagrams better drawn in SVG, HTML/CSS, or a chart library; charts, tables, and the user's own photographs.
**Hard rule — no signed-in lane, no picture**: when `list` (or a failed `generate`) reports no image lane, continue without and say so; never substitute a placeholder, a stock-photo URL, or an emoji.
**Default — one generation per job, one corrected retry**: a miss is retried once with a single targeted change (§2 step 4); a second miss is reported as "not achieved". Generation costs the user credits: no speculative variants or "another option" regenerations unless asked.

## 2. Call order
1. `media action:'list' kind:'image'` once per session before the first generate: signed-in lanes, models, and `remembered` — the lane/model a generate runs on when none is passed. Add `model:` for that model's controls; pass a control only when that model lists it.
2. **Hard rule — pick the source in this order**: a source the user names (GPT / ChatGPT / Codex / OpenAI, Grok, Gemini, Antigravity …) is passed as `lane`, resolved from `list`; if it is not signed in, say so rather than swap. Otherwise omit `lane`/`model` and let the runtime apply its configured defaults. Pass `lane`/`model` for capability only when the job needs one the selected model lacks (reference count, exact text, a listed resolution).
3. `media action:'generate' kind:'image', prompt, path, + controls`. The result reports lane, model, `laneSource` (`requested` = a lane explicitly selected in the call (a model alone is not), `pinned` = the user's configured default for images, `remembered` = their last choice, `first` = the default lane or the first available signed-in lane), and the options used. A pinned default that errors is reported, not swapped.
4. **Hard rule — look before using**: open the file with `read` and check subject, style, composition, the exclusions, any in-image text, and — for an edit — every item in the preserve list. A miss is fixed by changing one variable in the prompt and restating every invariant; never rewrite the whole prompt, and on an edit re-edit only the residual region with the same locks.
5. The result is also a Studio asset (`assetId`); the file at `path` is the copy the work uses.

## 3. Prompt invariants
When drafting a prompt for a job type, a mockup, a logo, or any edit, read `references/prompt-forms.md` for the line template, the edit brief, the anti-patterns, and the aspect table. These hold for every prompt:
- **Labeled lines in priority order**, never JSON: scene first, subject first when identity or product fidelity dominates. Only lines that change pixels.
- **Specificity**: a detailed user prompt is normalized and nothing is added; a generic one gets composition, intended use, and scene concreteness — never extra characters, props, brands, palettes, story beats, or placement the layout does not call for.
- **Exclusions follow the use**: a field for copy (hero, cover, OG, background) excludes text, logos, watermarks, and faces unless asked; an illustration or a scene with people excludes only logos and watermarks; a portrait keeps its face.
- **Narrative, not tags**: no keyword piles, quality tokens, or precision specs; one intent per line.
- **An edit names the delta and the locks**: the desired result, the one change, and the fragile properties to preserve (face, pose, silhouette, logo geometry, text spelling, framing, lighting). "Keep everything else the same" alone is weak; repeat the lock list on every retry. A removal says what replaces it. A source carrying drawn markup is sent clean, with the markup translated into instructions.
- **Text**: a field for copy gets none; the page sets its own type. When text must appear, or copy must be exact, read `references/text.md` first. Copy that must be exact is composited with a real font, not generated.

## 4. References, aspect, transparency
- `references:` take file paths (cap: `maxReferences`): the user's own file or one this session generated — never a downloaded third-party image. Each gets an index and a role in the prompt (`Image 1: base scene. Image 2: subject identity.`) plus the relationship. The reference whose fidelity matters most (face, logo, product) goes first; several faces that must stay recognizable are composed into one reference first. Use references for continuity: a series that must share a look, a recognizable product, a still that the video skill will animate.
- **Aspect comes from where the picture will live**, never from a previous generation (table in `references/prompt-forms.md`). Pass only a listed value; a model listing none gets none, so put the ratio in the prompt's composition. Resolution: highest listed for a hero, print, or full-bleed frame; default for drafts, thumbnails, and icons.
- **Cutouts**: for cutouts, stickers, icons, logos, background removal, and edits of an image that must stay transparent, pass `background: transparent` when the model lists it (`auto` drops alpha on edits). Otherwise generate on a stated solid background (`pure solid white #FFFFFF`, or black for reflective subjects; no gradient, no floor, no shadow, no vignette) and remove it afterwards. Never write "transparent background" in the prompt: it burns in a fake checkerboard.

## 5. Saving, reporting, provenance
- **Never overwrite**: an existing file gets a sibling (`hero-v2.png`) unless replacement was asked; output goes beside the work that uses it or where the user named.
- **Report** the final path, the lane/model that produced it (said to the user in plain words), options, and the final prompt (edit: the change and locks).
- **Declare generated media where it lands** (notes, caption, alt text, or message) with lane/model and prompt; never present it as a photograph of a real event, place, or person.

## 6. Failure
A `generate` error carries `lanes` or `available`: choose from it and call again, or continue without. `MEDIA_USAGE_LIMIT`: tell the user the reset time. `MEDIA_PARTIAL_ONLY`: no final image, nothing saved.

## Resources
- `references/prompt-forms.md` — when drafting a prompt for a job type, an edit, or a reference composition; choosing an aspect.
- `references/text.md` — when the image must contain text or copy must be exact.
