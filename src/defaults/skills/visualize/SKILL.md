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
This file owns when to draw and how a mockup is built, checked and shown; the
tool schema owns the action fields.

## 1. Which job

**Hard rule — seeing beats reading, or it is not this skill**: draw when the
answer is a layout, a state, a flow, a spatial relation, or a look. Scope,
tradeoffs and wording stay in chat even when the topic is UI.
**Hard rule — the page shows, it does not explain**: on-page text is a short
title, at most one lead line, one caption line per frame, and the copy of the
drawn UI. Rationale, specs and change lists go in the chat report, never on
the page.
**Hard rule — not this tool**: Office files, images and video are authored by
their own skills and only shown here. A local HTML page is checked with `open`
then `act`, never through a server you start; `browser` is for web URLs.

- _Show_: an artifact you produced or changed. `open` it once, when it is
  ready to look at; edits reload the tab.
- _Mockup_: a mockup or preview was asked for, or the look of a UI change is
  still the user's to decide (a settled look is built directly). §2.
- _Options_: the direction is genuinely open. §3.
- _Explain_: a flow, state machine, architecture or data path: one HTML
  diagram page.

## 2. Mockup loop

Read `references/craft.md` before the first mockup of a session.

1. **Ground in the product.** Read the tokens, theme and components of the
   touched surface before drawing, until you can name the component and
   values the change touches. For an existing screen prefer a capture of the
   running app with only the changed parts drawn over it.
2. **One frame per state** the user will meet (default, interaction, result,
   failure or empty where they exist), each captioned in one sentence.
3. **Write** `design/mockups/<topic>/index.html`, self-contained (inline CSS
   and JS, no network), with realistic sample data marked as sample once; no
   fake metrics or filler sections.
4. **Show**: `open` the page, then `annotate` each changed element with a short
   label.
5. **Look before you report**, fixing in the file until each is clean:
   `check` (no page problems); `inspect` at the panel's width and again at
   `viewport` `{width: 375, height: 812}`, fixed-size frames included (no
   findings, except text caught mid fade-in and targets shrunk only because a
   fixed frame is scaled to fit, each named in the report); `capture` against
   `references/craft.md` §5; `act` on every interaction the page has.
6. **Report** in chat: the path, the states shown, what to confirm. Then stop:
   implementation waits for approval.
7. **Iterate in place.** Feedback edits the same file; the panel keeps each
   saved state as a version, so never copy the file to keep an old one. A
   `<visualize_feedback>` block (pins, choices, tweaks) is answered with
   `references/feedback.md`.
8. **After approval** the mockup's values are the spec. `export` the approved
   tab beside the page when the work needs a record, remove what you created
   only to stage the mockup, and say so.

## 3. Options

One strong mockup by default; options only when the direction is open.
**Hard rule — options differ in stance, not in pixels**: pull 2–3 options
apart on one axis that matters for the decision (density, layout model,
emphasis, interaction model). A different accent colour or radius is the same
option.

- Name each by its stance and give its cost in one line; `open` them in one
  call to show them side by side.
- Make them pickable: `data-choice="<id>"` on each option's root, plus
  `data-choice-group="<decision>"` when a page asks more than one question
  (ungrouped choices form one group) and `data-choice-label` when its text
  does not name it. A click sets `data-choice-selected` on one per group:
  style `[data-choice][data-choice-selected]` to match the mockup. Picks
  arrive under `choices:` in `<visualize_feedback>`.
- After the pick, consolidate into one mockup and close the others.

## 4. Showing and reporting

- Your own checks and screenshots `open` with `verify: true`; the same target
  opened without it is shown to the user.
- Inline `content` is for diagrams, charts and sketches you will not edit
  again; a file is for anything iterated, versioned, annotated or kept.
- A value still open (colour, density, spacing, type scale, radius) is offered
  as a tweak: `references/feedback.md`.
- Close tabs that no longer match the conversation. A render error or page
  problem is fixed and opened again, never reported as shown; when
  `visualize` is unavailable, give the file path.
- `references/showing.md`: a web URL, a deck or document, a hidden panel.
- The report says what is on screen, the path and the decision needed, and
  states rendering you did not verify. Never repeat the page's source or
  re-render its data in chat.
