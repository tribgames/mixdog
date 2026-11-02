# Feedback and tweaks

Read when a user message carries a `<visualize_feedback>` block, or before
offering tweaks.

## Pins
The user can point at the page. The block lists numbered pins (`pin N` = the pin
numbered N they saw), each with its label, note, tab, project-relative file and
`kind` (pane kind + element or region).
- An HTML element pin adds its selector, `inside` path, trimmed HTML, key styles
  and box.
- A region pin (an HTML drag, a document, PDF, image, diagram, or video frame)
  adds its area, plus `elements` for an HTML drag and `time` for a video.
- The crop image "visualize pin N" comes when there is one (`crop: none`
  otherwise).

Answer pin by pin by number and act on what the selector or area names. Secret
values arrive as `[redacted]`: never restore them from the crop or guess them.

## Choices
Picks from `data-choice` options arrive under `choices:` as tab, file, group,
choice id and label (contract in SKILL.md §3).

## Tweaks
Offer them when the open decision is a value, not a layout. The page declares
them in `<script type="application/json" id="mx-tweaks">` (HTML files and
inline `html`/`chart`):
`[{"id":"accent","label":"Accent","type":"color","var":"--accent","default":"#3b82f6"}]`.
- Types: `color` (hex/rgb), `range` (`min`,`max`,`step`,`unit`), `select`
  (`options`), `toggle`; each sets a `--css-var` or a `data-*` attribute on the
  root, which your CSS reads.
- At most 6 meaningful controls (16 is the hard cap), each with a real default.
- The user's values return under `tweaks:` (`accent (--accent): #2f6fed (was
  #3b82f6)`): bake them in as the new defaults — both the CSS value and the
  control's `default`.
- A malformed block is a `tweaks: <reason>` page problem.
