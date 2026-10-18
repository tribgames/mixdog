---
name: visualize
description: Show mockups, design options, diagrams, and finished artifacts in the side panel beside the chat.
when_to_use: 'Mockups, previews, design options, diagrams, or showing any finished artifact; not code alone.'
metadata:
  requires: visualize
dependencies:
  tools:
    - type: tool
      value: visualize
---

# Visualize (visualize tool)

The side panel is where the user sees the work instead of reading about it.
This file owns when to draw, how a mockup is built and iterated, and how results
are shown. The schema owns action fields. `references/craft.md` owns the design
bar every mockup is held to; read it before the first mockup of a session.

## 1. Which job
**Hard rule — seeing beats reading, or it is not this skill**: draw when the
answer is a layout, a state, a flow, a spatial relation, or a look. Scope,
tradeoffs, and wording decisions stay in chat even when the topic is UI.
- *Show* — any artifact you produced or changed (HTML, deck, document, sheet,
  PDF, image, video, a local dev page): `open` it once when it is ready. Edits
  reload the tab by themselves; never reopen to refresh.
- *Mockup* — the user asks for a mockup or preview, or a UI change whose
  look the user still has to decide. A change whose look is already settled
  is built directly. §2.
- *Options* — the direction is genuinely open (the user is unsure, or two
  readings of the request lead to different layouts). §3.
- *Explain* — a flow, state machine, architecture, or data path the user needs
  to grasp: one HTML diagram page, no option machinery.
**Hard rule — not this tool**: authoring Office files, images, or video belongs
to their own skills; this skill only shows their output. Clicking, typing, and
testing a page belong to `browser`.

## 2. Mockup loop
1. **Ground in the real product.** Read the files that define the touched
   surface — tokens, theme, the component and its neighbours — before drawing.
   For an existing app screen, prefer the real screen (a capture of the running
   app) with only the changed parts drawn over it; invented chrome hides what
   actually changes. Done when you can name the exact component and values the
   change touches.
2. **Split the change into states.** Every state the user will meet gets its
   own labelled frame: A default, B the interaction, C the result, D failure or
   empty where they exist. One frame per state, captioned with what changed and
   why in one sentence.
3. **Write** `design/mockups/<topic>/index.html` (self-contained: inline CSS
   and JS, no network). Sample data is realistic and marked as sample once in
   the lead line; never fake metrics or filler sections.
4. **Show**: `open` the page, then `annotate` each changed element with a short
   label. Marks live on the panel, not in the file.
5. **Look before you report.** Run `visualize check` on the tab and fix every
   reported page problem (uncaught errors, CSP violations, console errors,
   missing assets, blocked network requests: the page must be self-contained)
   in the file, then `check` again until it reports none; a
   "Page problems" section on any `open`, `annotate`, or `capture` result counts
   the same. Then run `visualize inspect` on the tab: once at the panel's
   width and, when the design is responsive, again with `viewport`
   `{width: 375, height: 812}`; fix every finding it lists (overflow, clipped
   text, tiny or overlapping targets, low contrast, missing alt or labels) in
   the file before reporting. Then `capture` the tab (or read it through
   `browser`) and check it against `references/craft.md` §5; fix what fails
   before the user sees the report.
6. **Report** in chat: path, the states shown, what to confirm, and the open
   questions. Then stop — implementation waits for approval.
7. **Iterate in place.** Feedback edits the same file; the tab reloads and the
   panel keeps each saved state as a version (v1…vN) the user can step back
   to, compare side by side, or restore, so never copy the file to keep an
   old version. The user can also point at the page: their message then carries a
   `<visualize_feedback>` block of numbered pins (`pin N` = the pin numbered
   N they saw), each with its label, note, tab, project-relative file and
   `kind` (pane kind + element or region). An HTML element pin adds its
   selector, `inside` path, trimmed HTML, key styles and box; a region pin
   (an HTML drag, a document, PDF, image, diagram, or video frame) adds its
   area, plus `elements` for an HTML drag and `time` for a video. The crop
   image "visualize pin N" comes when there is one (`crop: none` otherwise).
   Answer pin by pin by number and act on what the selector or area names;
   secret values arrive as `[redacted]`, so never restore them from the crop
   or guess them.
8. **After approval**: implement from the approved mockup; its values are the
   spec. When the work needs a record, `export` the approved tab to PNG or PDF
   beside the page (`export` with `format` and a project-relative `output`,
   e.g. `design/mockups/login/login-approved.png`; `version` for a kept
   version). A single HTML page renders whole in a hidden window, so the tab need
   not be on screen; the result lists the written path, size, and any page
   problems. Remove any temporary data or records you created to stage
   the mockup, and say so.

## 3. Options
**Default — one strong mockup.** Options only when the direction is open.
**Hard rule — options differ in stance, not in pixels**: pick one axis that
matters for this decision (density, layout model, emphasis, interaction model)
and pull the 2–3 options apart on it. Two options that differ by accent colour
or radius are one option.
- Name each by its stance ("1 · one menu", "2 · inline chips") and give its
  cost in one line.
- `open` 2–3 targets in one call to show them side by side.
- Make the options pickable: put `data-choice="<id>"` on each option's root
  (and `data-choice-group="<decision>"` when one page asks more than one
  question; ungrouped choices form one group). A click selects one per group
  and adds `data-choice-selected` to it; the panel's default outline uses
  `:where()`, so style `[data-choice][data-choice-selected]` to match the
  mockup. `data-choice-label` names it when its text does not. Picks reach
  you with the user's next message under `choices:` in the
  `<visualize_feedback>` block as tab, file, group, choice id and label.
- When the user picks, consolidate into one mockup and close the others; a
  pile of options is not a result.

## 4. Showing results
- Open a result once, when it is ready to look at, not at every intermediate
  write. Long multi-step work shows the first reviewable state, then lets
  reloads carry the rest.
- Decks and documents: the panel shows the converted pages; still run the
  owning skill's own render review — the panel is for the user, not your QC.
- Close tabs that no longer match the conversation (a resolved choice, a
  replaced draft) so the user is never looking at stale work.
- A web URL is opened alone, never mixed with files; marking, capturing, or
  closing a web page belongs to `browser`.
- `annotate` and `capture` need the tab on screen (`export` of an HTML page does not). When they report the panel
  is hidden, tell the user to open it rather than retrying.
- When `visualize` is unavailable, give the file path; never start your own
  server or pretend it was shown.

### Inline content or a file
- **Inline** (`open` with `input.content` — `mermaid`, `svg`, `chart` (an
  ECharts option as JSON), `html`, `markdown`): diagrams, charts, quick
  sketches and notes you will not edit again. No file is written. `mermaid`,
  `svg` and `markdown` are static, sanitized output (no scripts). `chart` is
  interactive (tooltips, zoom) and `html` runs its scripts, as in-memory pages
  held to the same rules as an HTML file: outside network is blocked, so an
  `html` sketch must be self-contained, and its page problems come back in the
  result. Re-opening with the same `title` adds a version.
- **File** (`targets`): a real mockup that needs iteration, scripts, assets,
  versioning on disk, annotate/Comment feedback, or a deliverable the user keeps.
- A render error comes back as a page problem (Mermaid parse error, bad chart
  JSON): fix the source and open again; never report it as shown.

### Tweaks
Offer tweaks when the open decision is a value, not a layout: colour, density,
spacing, type scale, radius. The page declares them in
`<script type="application/json" id="mx-tweaks">` (HTML files and inline
`html`/`chart`): `[{"id":"accent","label":"Accent","type":"color","var":"--accent","default":"#3b82f6"}]`.
Types: `color` (hex/rgb), `range` (`min`,`max`,`step`,`unit`),
`select` (`options`), `toggle`; each sets a `--css-var` or a
`data-*` attribute on the root, which your CSS reads. Keep it to 6 or fewer
meaningful controls (16 is the hard cap) and give every one a real default.
The panel adds a Tweaks button; when the user sends their values you get them
under `tweaks:` in `<visualize_feedback>` (`accent (--accent): #2f6fed (was
#3b82f6)`): bake them into the file as the new defaults — both the CSS value
and the control's `default`. A malformed block is a `tweaks: <reason>` page
problem.

## 5. Reporting
Short: what is on screen, the path, the decision you need. Do not narrate the
HTML. Uncertain or unverified rendering is stated, not glossed.
The panel and the chat card already show the content: never repeat its source
(Mermaid text, chart JSON, SVG, HTML) or re-render its data as a chat table or
text chart. Name the tab and give one or two lines on what it shows or what to
look at.
