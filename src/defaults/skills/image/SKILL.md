---
name: image
description: Use when an image is to be made or edited — a product shot, a hero or social image, an illustration, an icon, a texture, a figure for a document or deck, a background swap, an object removal, a cutout, a style transfer — through the media tool (Mixdog Media Studio). Carries the list → generate → inspect call order, the labeled prompt form, the edit brief, reference roles, text inside images, aspect and size, saving, and provenance. Load before the first media call for an image; a video clip is the video skill.
metadata:
  requires: media
---

# Image generation and editing (media tool · Media Studio)

This file owns the judgement around one tool for still images: how a picture is asked for, checked, and saved. It is not tied to any deliverable — a deck, a document, or a page that needs a picture loads this skill and keeps only its own placement rules. The lane catalog (providers, models, controls, sign-in state) lives in the runtime and is read with `list`; nothing here names a lane or a model, so this file stays true when providers change.

## 1. Which kind of job
**Hard rule — generate or edit, decided first**: → manual
- *Generate* — the user wants a new image (product shot, hero, social card, illustration, icon, texture, concept) or a deliverable needs one. Images the user attaches only as style, mood, or composition guidance still make this a generate with references.
- *Edit* — the user wants an existing image kept and part of it changed: background swap, object removal, lighting or weather, text replacement, style transfer, compositing, cutout. The source image goes in `references` as the edit target; §3 edit brief applies.
**Hard rule — not this tool**: extending a repository's own SVG, icon, or logo system; simple shapes, wireframes, and diagrams that are better drawn in SVG, HTML/CSS, or a chart library; charts, tables, and the user's own photographs, which a generated picture never replaces. → manual
**Hard rule — no signed-in lane, no picture**: when `list` (or a failed `generate`) reports no image lane, continue without and say so; never substitute a placeholder, a stock-photo URL, or an emoji. → manual
**Default — one generation per job, one corrected retry**: a result that misses the brief is retried once with a single targeted change (§2 step 3); a second miss is reported as "not achieved", not a third attempt. Several candidates only when the user asks for choices.

## 2. Call order
1. `media action:'list' kind:'image'` once per session before the first generate: signed-in lanes, their models, and each model's controls (`aspectRatio` / `size`, `resolution`, `quality`, `maxReferences`). Add `model:` for one model's controls.
2. `media action:'generate' kind:'image', prompt, path, lane, model, + controls` — lane and model chosen from `list`, controls only from that model's list. Omitting lane and model picks the first signed-in lane's default; the result reports the lane, model, and options actually used, and those go into the report.
3. **Hard rule — look before using**: open the file with `read` and check subject, style, composition, the exclusions, any in-image text, and — for an edit — every item in the preserve list. A miss is fixed by changing one variable in the prompt and restating every invariant; never rewrite the whole prompt, never use an unseen result. → manual
4. The result is also a Studio asset (`assetId`); the file at `path` is the copy the work uses.

## 3. Prompt form
**Hard rule — labeled lines, in priority order**: the model reads order as priority; scene first by default, subject first when identity or product fidelity dominates. Use only the lines that change pixels; add a short labeled line when it materially helps. Never wrap the prompt in JSON. → manual
```
Use: photorealistic | product-mockup | ui-mockup | infographic | logo-brand | illustration | stylized-concept | historical-scene   (edit: text-replace | identity-preserve | object-edit | lighting-weather | cutout | style-transfer | compositing | sketch-to-render)
Asset: where it will be used — hero, OG card, figure, avatar, sprite, texture, cover
Scene: a specific environment, never "a nice background"
Subject: one subject with material, color, shape, posture; count and position bound in the same sentence
Style: photograph / flat illustration / 3D render / watercolor …; light source and direction; depth; grain
Composition: framing (wide, medium close-up, top-down), subject placement, where empty space for copy sits — only when the use needs it
Mood: color temperature or palette named as a mood; exact hex only when the asset must match a UI
Text: "exact words" · script · font style · size · placement            (only when text is wanted)
Keep: invariants that must not change                                   (edits; see the edit brief)
Avoid: no logos, no watermarks; plus no text / no faces when the use calls for it
```
**Default — specificity policy**: a detailed user prompt is normalized into this form and nothing is added; a generic one gets composition, intended use, and scene concreteness — never extra characters, props, brand names, palettes, story beats, or a left/right placement the layout does not call for.
**Default — exclusions follow the use**: a field for copy (hero, cover, OG, background) excludes text, logos, watermarks, and faces unless asked; an illustration or a scene with people excludes only logos and watermarks; a portrait keeps its face. "No text" is not a universal default.
**Hard rule — anti-patterns**: → manual
| Pattern | Why it fails | Instead |
|---|---|---|
| keyword soup (`beautiful, stunning, 8k, trending`) | tag piles read as noise | narrative sentences: subject + attributes + relations |
| quality tokens (`masterpiece`, `ultra-detailed`) | do nothing visible | lens, light, and framing language |
| precision specs (`85mm f/1.2`, `5600K`) | read loosely | perceptual terms: `medium close-up`, `warm tungsten` |
| contradictory constraints (`minimal` + twelve objects) | some get dropped silently | one intent per line |

**Edit brief** — an edit names the delta and the locks, not the whole picture:
```
Desired result: one sentence describing the edited image's final state
Change only: the specific modification
Preserve exactly: named locks — face structure, pose, product silhouette, logo geometry, text spelling, framing, perspective, palette, lighting, shadows
Do not add or remove: protected elements
```
"Keep everything else the same" alone is weak: name the fragile properties, and repeat the same lock list on every retry. A removal is written as what replaces it ("show the continuous desk grain where the note was, matching lighting and perspective — no residue or outline"), never as "remove X" alone. A source carrying drawn markup (arrows, boxes, notes) is sent clean, with the markup translated into instructions — the model reproduces marks it sees.

## 4. Text inside the image
**Default — text only when wanted**: a field for copy gets no text; the deliverable or the page sets its own type over it.
**Hard rule — when text is wanted, it is exact**: the words in quotes, the language and script, the font style, the approximate size, the placement, and "once, with no other readable text". Uncommon words are spelled letter by letter. Korean: write the prompt in English and quote only the Hangul string; start with short label-length strings. → manual
**Hard rule — copy that must be exact is composited, not generated**: packaging, UI, legal, or brand copy is generated as an empty reserved area (`no text` in that region) and set afterwards with a real font by the deliverable or an image tool. → manual
**Default — always inspect rendered text** (§2 step 3); garbled or substituted glyphs are common. One targeted text-only edit pass may follow; if spelling still drifts, stop and composite.

## 5. Reference images
`references:` takes file paths; the model's `maxReferences` caps them. A reference is the user's own file or one this session generated — never a downloaded third-party image.
**Hard rule — each reference gets an index and a role in the prompt**: `Image 1: base scene and composition. Image 2: subject identity. Image 3: style only.` followed by the relationship ("place the subject from Image 2 into Image 1; apply only Image 3's palette; preserve Image 1's framing and lighting"). → manual
**Default — identity first**: the reference whose fidelity matters most (a face, a logo, a product) goes first. Several faces that must all stay recognizable are composed into one reference image before generating, not passed as separate portraits.
**Default — references for continuity**: a series that must share a look, a recognizable product, a still that the video skill will animate.

## 6. Aspect, size, and resolution
**Hard rule — aspect comes from where the picture will live, never from a previous generation**: → manual
| Destination | Aspect |
|---|---|
| a frame in a deck, document, or page | the frame's ratio (full-bleed 16:9 → `16:9`; side panel → `9:16` / `3:4`; square figure → `1:1`), cropped by the placement, never stretched |
| landing hero, wide banner | landscape `16:9` or `3:2` |
| mobile hero, story | portrait `9:16` |
| OG / social share card | the listed aspect closest to 1.91:1 |
| icon, avatar, texture, tile | `1:1` |
| a still for a video clip | the clip's aspect |
The value must be one the model lists; when a model lists sizes instead of ratios, pick the closest size.
**Default — resolution**: the highest the model lists for a hero, print, or full-bleed frame; the default for drafts, thumbnails, and icons. Quality tokens only when the model lists them.
**Default — cutouts**: models do not produce real alpha; generate on a stated solid background (`pure solid white #FFFFFF`, or black for reflective subjects; "no gradient, no floor, no shadow, no vignette") and remove it afterwards. Never ask for "transparent background" — it burns a fake checkerboard into the image.

## 7. Saving, reporting, provenance
**Hard rule — never overwrite**: an existing file gets a sibling (`hero-v2.png`, `photo-edited.png`) unless the user asked for replacement. Output goes beside the work that uses it or where the user named; nothing lives only in a temp folder. → manual
**Hard rule — the report names what was made**: final path, lane/model, options, and the final prompt (for an edit, the change and the locks). → manual
**Hard rule — generated media is declared where it lands**: the deliverable that places it records it as generated with lane/model and prompt (speaker notes, figure caption, alt text, or the message). A generated picture is never presented as a photograph of a real event, place, or person. → manual

## 8. Failure and cost
- A `generate` error carries `lanes` (what is signed in for images) or `available` (models); choose from it and call again, or continue without.
- Generation costs the user credits or quota on that provider: one call per job, no speculative variants, no regeneration "to see another option" unless asked.
- When a retry is needed, first try re-editing only the residual region with the same locks rather than enlarging the prompt.
