# Craft bar for mockups and visual pages

The bar is "a designer on this product drew it", not "a page was generated".
Most generated-looking design is wrong composition, not wrong colour; fix the
cause in the order below.

## 1. Source before taste
- An existing product wins over every rule here. Lift its real tokens,
  spacing, radii, type, copy tone, and density from source files; do not
  approximate from memory or a screenshot when the code is readable.
- A new surface with no system: define a small one first (4–6 named colours,
  one or two type families with roles, a spacing step, one radius scale) and
  write it as CSS variables at the top of the page.
- A brief's explicit direction wins, including when it asks for a look this
  file warns against.

## 2. Name the surface, then compose
Before any colour or component, decide in one line what the user does here;
the composition follows from it:

| Surface | User is… | Composition carries |
|---|---|---|
| Watch | following changing state | density, glanceable hierarchy, no marketing framing |
| Act | working through items | selection, row actions, clear current item |
| Compare | weighing options | aligned columns, equal structure, one differentiator |
| Set up | configuring | grouped fields, save/validation states, little decoration |
| Persuade / teach | being convinced or taught | one idea per section; the only place a hero belongs |
| Browse | exploring a space | filters, results, peek/zoom |
| Drive / inspect | commanding or drilling into one object | keyboard paths, focus, detail panes |

A screen spanning two picks a primary one; never average them.

## 3. Hierarchy with type and space first
- Scale, weight, and spacing carry hierarchy before boxes, borders, icons, or
  colour. Add a container only when it groups something the user acts on.
- Line length under ~80 characters; numbers in tables tabular and aligned.
- Structural marks (numbers, dividers, labels) only when they encode real
  information — numbered steps only for a real sequence.
- One memorable element per page; everything around it stays quiet.

## 4. Words are interface
- Name things by what the user understands, not how the system is built.
- Buttons say what happens ("Save changes"); the same action keeps the same
  name through the flow ("Publish" → "Published").
- Errors say what happened and what to do, without apology. Empty states
  invite the next action.
- Sentence case, plain verbs, no filler or invented claims. Draft copy is
  marked as draft.

## 5. Self-review before showing
Look at the capture, list which of these fire, then repair by cause:

Composition (re-layout; recolouring will not fix these):
1. Wrong surface — e.g. a hero on a dashboard.
2. Everything centred because no layout was chosen.
3. Equal-weight tile grids (icon + heading + sentence ×3) where one thing
   should lead.

Decoration (remove; replace with scale, weight, or spacing):
4. Coloured side rails on cards.
5. Blur or glass with no elevation system behind it.
6. Oversized stat numbers filling space meant for content.
7. A rounded icon above every heading; icons that do not aid scanning.
8. Identical cards, one radius and one soft shadow on everything.

Defaults (recolour / re-typeset only if the brief left them free):
9. Indigo/violet accent or glossy gradient chosen by habit.
10. Default font used without a reason; ALL-CAPS eyebrow labels over every
    heading; one word accented in a headline; "→" on every link.

Re-check after repairing. Do not show while 1–3 still fire.

## 6. Quality floor (always, without announcing it)
`visualize inspect` reports most floor failures (overflow, clipped text,
small or overlapping targets, low contrast, missing alt or labels); a page is
not shown while it lists any.
- Visible keyboard focus, real hover and disabled states where shown.
- Readable contrast for text and controls; hit targets ≥ 44px on touch frames.
- Motion only when it shows what changed; respect `prefers-reduced-motion`.
- Fits the panel width without horizontal scroll; frames wider than the panel
  scale down rather than clip. A fixed-size frame that reproduces an app
  surface (a window, an overlay, a stage of set pixel size) sits in a wrapper
  that scales it as a whole: the wrapper is `width: 100%; overflow: hidden`,
  the frame gets `transform: scale(min(1, wrapperWidth / frameWidth))` from
  `transform-origin: 0 0`, the wrapper's height is set to the scaled height,
  and a `ResizeObserver` on the page re-runs this when the panel resizes.
  Never give such a frame `max-width` alone: its contents keep their pixel
  positions and spill out.
- Self-contained: no CDN, web font, API or other network request. The panel
  blocks outside network unless the user allows it (a blocked request is a
  `blocked-network` page problem), so inline or bundle every asset in the
  project. No fake data passed off as real, or stock imagery.
- A value the user may want to tune (accent, density, spacing) is a CSS variable
  on the root plus a control in `<script type="application/json" id="mx-tweaks">
  [{"id":"accent","type":"color","var":"--accent","default":"#3b82f6"}]`.
