# Image catalog validation — 2026-09-09

## Scope and evidence

The approved additional budget was 20 generation/edit requests. All 20 were
used; there were no paid retries. Model discovery requests are separate.
The ledger and generated images are in `artifacts/media-image-20260909/`.
The contact sheet was visually inspected and the image files decoded with
Pillow. All successful edits changed the blue subject to red. This is a basic
functional check, not a model-quality benchmark; shape preservation varied.

| Route | Additional requests | Result |
| --- | ---: | --- |
| Gemini API key | 6 generation + 4 edit | 9 images, 1 initial empty generation |
| Grok account | 3 generation + 3 edit | 6 images |
| Grok API key | 0 | Catalog HTTP 403: exhausted credits or spending limit |
| OpenAI account | 2 Responses + 2 direct edit | 4 images; model/setting selection not verified |
| OpenAI API key | 0 | Key configured, but no image lane implemented |

No API billing settings, credentials, deployment, or Git commits were changed.
The OpenAI API-key image route remains out of scope.

## Gemini

Generation covered:

- `gemini-2.5-flash-image`
- `gemini-3.1-flash-image`
- `gemini-3.1-flash-image-preview`
- `gemini-3.1-flash-lite-image`
- `gemini-3-pro-image`
- `gemini-3-pro-image-preview`

The initial Pro stable request returned no image. The adapter was updated to
request `responseModalities: ["TEXT", "IMAGE"]` explicitly. Subsequent editing
with Pro stable returned an image. Its text-only generation was **not rerun**
after that change because the request budget was exhausted.

Editing covered the four non-preview models. Square output was 1024×1024.
Successful landscape generation was 1376×768, or 1344×768 for Gemini 2.5.
Resolution selection and preview-model editing were not tested or newly exposed.
Requested aspect ratios are approximate provider-native image dimensions.

## Grok

Account generation and editing covered `grok-imagine-image`,
`grok-imagine-image-quality`, and `grok-imagine-image-2.0`.
Generation with `16:9` / `1k` produced 1280×720.
Editing with `1:1` / `2k` produced 2048×2048.
Multiple-reference editing was not separately tested.

The API-key catalog failure was a billing restriction, not an OAuth failure or
a malformed model catalog. Catalog diagnostics now preserve that distinction
without exposing upstream account identifiers. No alternate credential is used
to bypass the restriction.

## OpenAI account: accepted is not verified

Earlier direct generation requests with `gpt-image-2.5-flare` and
`gpt-image-2.5-sunburst` returned PNG data, but no actual model identifier.
Those two successes were reused instead of repeating generation.

The two additional Responses requests set `tools[0].model` to those IDs.
Both image results identified **`gpt-image-2-codex`**, not the requested 2.5
variant. Both returned 1254×1254 despite a 1024×1024 request.

The two direct edit requests also returned 1254×1254 despite a 1536×1024
request. Neither identified the actual engine. Thus HTTP 200 and returned image
bytes do not establish Flare/Sunburst selection or size/quality control.

The catalog therefore exposes a single **ChatGPT Image · Auto** route, with
internal route ID `chatgpt-image-auto`. It is explicitly not an upstream model
ID. A current compatible GPT from the account catalog orchestrates generation;
the image engine is selected by the server. Explicit output size and quality
are not offered or silently accepted. API documentation for 2.5 is not treated
as an OAuth entitlement.

## Catalog changes

- Separate provider names and authentication labels.
- Preserve generation, Lite/Pro/Quality, and Preview distinctions.
- Show IDs alongside readable names; disclose the automatic OpenAI route.
- Prefer a stable non-Lite Gemini image model by default, without claiming
  that version sorting is a quality ranking.
- Translate catalog failures into safe billing/auth/access/rate/timeout codes.
- Mark stale catalogs and never reuse them after a billing/auth rejection.
- Keep refresh/retry available without switching credential lanes.

## Sources

- Local `C:\Project\refs\lobe-chat` and `cherry-studio` model catalogs.
- Local `C:\Project\refs\codex` image client and authentication routing.
- https://developers.openai.com/api/docs/guides/image-generation
- Live credential-scoped model discovery and the request ledger above.
