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

# Visualize

The side panel is where the user sees the work instead of reading about it.
This file owns when to draw, how a mockup is built and iterated, and how
results are shown; the tool schema owns action fields.

## 1. Which job
**Hard rule — seeing beats reading, or it is not this skill**: draw when the
answer is a layout, a state, a flow, a spatial relation, or a look. Scope,
tradeoffs, and wording decisions stay in chat even when the topic is UI.
- *Show* — any artifact you produced or changed (HTML, deck, document, sheet,
  PDF, image, video, local dev page): `open` it once when ready. Edits reload
  the tab; never reopen to refresh.
- *Mockup* — the user asks for a mockup or preview, or a UI change whose look
  the user still has to decide (a settled look is built directly). §2.
- *Options* — the direction is genuinely open (the user is unsure, or two
  readings lead to different layouts). §3.
- *Explain* — a flow, state machine, architecture, or data path to grasp: one
  HTML diagram page, no option machinery.

**Hard rule — not this tool**: authoring Office files, images, or video
belongs to their own skills; this skill only shows their output. Clicking,
typing, and testing a local HTML page is `open` then `act` here (`verify: true`
for your own check); `browser` is for web URLs.
**Hard rule — never start your own server to check a local HTML page**
(`python -m http.server`, `npx serve`, …): open it here and operate it with `act`.

## 2. Mockup loop
Read `references/craft.md` before the first mockup of a session.
1. **Ground in the real product.** Read the files that define the touched
   surface — tokens, theme, the component and its neighbours — before drawing.
   For an existing app screen, prefer a capture of the running app with only
   the changed parts drawn over it; invented chrome hides what changes. Done
   when you can name the exact component and values the change touches.
2. **Split the change into states.** Each state the user will meet gets its
   own labelled frame: A default, B the interaction, C the result, D failure or
   empty where they exist, captioned in one sentence (what changed and why).
3. **Write** `design/mockups/<topic>/index.html` (self-contained: inline CSS
   and JS, no network). Sample data is realistic and marked as sample once in
   the lead line; never fake metrics or filler sections.
4. **Show**: `open` the page, then `annotate` each changed element with a short
   label. Marks live on the panel, not in the file.
5. **Look before you report.** Run `visualize check` on the tab and fix every
   reported page problem (uncaught errors, CSP violations, console errors,
   missing assets, blocked network requests: the page must be self-contained)
   in the file, then `check` again until it reports none; a "Page problems"
   section on any `open`, `annotate`, or `capture` result counts the same.
   Then run `visualize inspect` on the tab twice, for every page (fixed-size
   app frames included): once with no `viewport` (the panel's width) and once
   with `viewport` `{width: 375, height: 812}`. Fix every finding (overflow,
   clipped text, tiny or overlapping targets, low contrast, missing alt or
   labels) in the file before reporting. Two findings are not defects and may
   stay: text caught mid fade-in, and targets shrunk only because a fixed frame
   is scaled down to fit (craft.md §6); name each one left and why in the
   report. Then `capture` the tab and check it against `references/craft.md`
   §5; fix what fails before the user sees the report. A page with
   interactions (menus, forms, states) is tried with `act`: click, type and
   press keys on the selectors `inspect` reported, read values with
   `evaluate`, and pass `output` to capture the state the steps end in.
6. **Report** in chat: path, the states shown, what to confirm, open
   questions. Then stop — implementation waits for approval.
7. **Iterate in place.** Feedback edits the same file; the panel keeps each
   saved state as a version (v1…vN) the user can step back to, compare or
   restore, so never copy the file to keep an old version. When the message
   carries a `<visualize_feedback>` block (pins, choices, tweaks), read
   `references/feedback.md` and answer pin by pin by number.
8. **After approval**: implement from the approved mockup; its values are the
   spec. When the work needs a record, `export` the approved tab to PNG or PDF
   beside the page (project-relative `output`, e.g.
   `design/mockups/login/login-approved.png`; `version` for a kept version).
   Remove any temporary data or records you created to stage the mockup, and
   say so.

## 3. Options
**Default — one strong mockup.** Options only when the direction is open.
**Hard rule — options differ in stance, not in pixels**: pick one axis that
matters for this decision (density, layout model, emphasis, interaction model)
and pull the 2–3 options apart on it. Two options that differ by accent colour
or radius are one option.
- Name each by its stance ("1 · one menu", "2 · inline chips") and give its
  cost in one line.
- `open` 2–3 targets in one call to show them side by side.
- Make the options pickable: `data-choice="<id>"` on each option's root (add
  `data-choice-group="<decision>"` when one page asks more than one question;
  ungrouped choices form one group; `data-choice-label` names it when its text
  does not). A click selects one per group and sets `data-choice-selected`;
  the default outline uses `:where()`, so style
  `[data-choice][data-choice-selected]` to match the mockup. Picks arrive with
  the user's next message under `choices:` in `<visualize_feedback>`.
- When the user picks, consolidate into one mockup and close the others; a
  pile of options is not a result.

## 4. Showing results
- Open a result once, when ready to look at, not at every intermediate write.
  Long multi-step work shows the first reviewable state, then lets reloads
  carry the rest.
- To check your own work (`check`, `inspect`, `act`, `capture`, `export`,
  before/after screenshots), `open` with `verify: true`; opening the same
  target without it shows it.
- Close tabs that no longer match the conversation (a resolved choice, a
  replaced draft).
- When `visualize` is unavailable, give the file path; never start your own
  server or pretend it was shown.
- Read `references/showing.md` for a web URL, a deck or document, or a hidden
  panel.
- **Inline** (`open` with `input.content`): diagrams, charts and quick sketches
  you will not edit again; never a report of your own work. `html` and `chart`
  are held to the same self-contained rules as an HTML file. **File**
  (`targets`): a real mockup that needs iteration, scripts, assets, versioning
  on disk, annotate/Comment feedback, or a deliverable the user keeps.
- A render error comes back as a page problem: fix the source and open again;
  never report it as shown.
- Offer tweaks when the open decision is a value, not a layout (colour,
  density, spacing, type scale, radius): read `references/feedback.md` for the
  block format and baking rules.

## 5. Reporting
Short: what is on screen, the path, the decision you need. Do not narrate the
HTML. Uncertain or unverified rendering is stated, not glossed.
The panel and the chat card already show the content: never repeat its source
(Mermaid text, chart JSON, SVG, HTML) or re-render its data as a chat table or
text chart. Name the tab and give one or two lines on what it shows or what to
look at.
