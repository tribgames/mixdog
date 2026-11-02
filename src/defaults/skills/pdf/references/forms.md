# Forms on an existing PDF

Read before filling a form, adding fields, or placing answers on a form without fields. Fields declared while creating a PDF are in `blocks.md` §3.

## 1. A form with fields
- `fill_form` with `values:{ name: value }` — text strings, checkbox `true|false`, radio and dropdown by option text, optionlist an array. Unknown names or options fail listing what exists, so read `fields` from the snapshot first (`/field[N]` with `type`, `value`, `options`, `readOnly`, `widgets`).
- A value wider or taller than its box is stored whole but drawn cut, so the result reports `clipped:[{ field, reason, needs, box }]` with a `warning`: shorten the value, enlarge the box, or lower the field's `fontSize`.
- `add_form_field` adds a field (the box is linted before it is added); `flatten_form` / `fill_form flatten:true` bakes the values in.
- `preview_fields` (`output:<copy.pdf>`, `boxes:[{ page, x, y, width, height, label }]`) writes a copy with every field — and any box you propose for a form without fields — outlined and named; render that copy and look before filling or adding fields.

## 2. A form without fields
`pdf-layout` returns text `items`, rules (`lines`), `boxes` (`checkbox:true` for a small square), and `links` (`url` or target `page`) in displayed top-left coordinates. Place an answer with `add_text` at `x: label.x + label.width + 4, y: page.height - line.y1 + 2`; add `origin.x`/`origin.y` if reported. Text items may carry `vertical`/`reversed` reading direction. Render afterwards and look.
