# Prompt forms

## Line template (generate)

Use only the lines that change pixels.

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

## Anti-patterns

| Pattern | Why it fails | Instead |
|---|---|---|
| keyword soup (`beautiful, stunning, 8k, trending`) | tag piles read as noise | narrative sentences: subject + attributes + relations |
| quality tokens (`masterpiece`, `ultra-detailed`) | do nothing visible | lens, light, and framing language |
| precision specs (`85mm f/1.2`, `5600K`) | read loosely | perceptual terms: `medium close-up`, `warm tungsten` |
| contradictory constraints (`minimal` + twelve objects) | some get dropped silently | one intent per line |

## Edit brief

```
Desired result: one sentence describing the edited image's final state
Change only: the specific modification
Preserve exactly: named locks — face structure, pose, product silhouette, logo geometry, text spelling, framing, perspective, palette, lighting, shadows
Do not add or remove: protected elements
```

A removal is written as what replaces it ("show the continuous desk grain where the note was, no residue or outline"), never as "remove X" alone. The model reproduces marks it sees, so arrows, boxes, or notes drawn on a source are removed from the file and restated as instructions.

## Aspect by destination

| Destination | Aspect |
|---|---|
| a frame in a deck, document, or page | the frame's ratio (full-bleed 16:9 → `16:9`; side panel → `9:16` / `3:4`; square figure → `1:1`), cropped by the placement, never stretched |
| landing hero, wide banner | landscape `16:9` or `3:2` |
| mobile hero, story | portrait `9:16` |
| OG / social share card | the listed aspect closest to 1.91:1 |
| icon, avatar, texture, tile | `1:1` |
| a still for a video clip | the clip's aspect |

When sizes are listed instead of aspects, pass the closest size.
