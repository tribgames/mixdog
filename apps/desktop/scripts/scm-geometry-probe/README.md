# Source Control overlay geometry probe

jsdom has no layout engine, so the dock's overlay rules (branch panel), its
toolbar geometry and its label degradation cannot be verified by the DOM suites.
This probe mounts the REAL `SourceControlDock` with the REAL stylesheets inside
Electron's Chromium and reports measured rectangles.

```sh
cd apps/desktop
node scripts/scm-geometry-probe/build.mjs
npx electron scripts/scm-geometry-probe/main.cjs \
  --cases=380x687,300x687,290x687,290x420,290x420:many,290x687:rows --out=scm.report.json
node scripts/scm-geometry-probe/summarize.mjs scm.report.json
```

`--cases` is a list of `<dock width>x<window content height>[:many|:rows]`; 300 is
`DESKTOP_UTILITY_DOCK_MIN_WIDTH` (`src/shared/window-layout.ts`) and 290 is the
width the overlay defects were reported at. The height resizes the REAL
BrowserWindow (`main.cjs` calls `setContentSize` per case), so `290x420` is a
genuinely short WINDOW — it used to shrink `#shell` inside a 687px viewport,
which never tested overlay containment at all. `:many` swaps the branch fixture
for one with 40 branches; `:rows` swaps the CHANGED-FILE and HISTORY fixtures
for 2000 files and a skip/limit-paged 120-commit log — the scenario the
windowed lists exist for.

`summarize.mjs` ASSERTS every rule below and exits nonzero (`FAIL (n):` with one
line per violation) when any of them breaks, so the probe is a real check.

The rules the overlays must keep:

- every panel is fully INSIDE the window,
- the commit row carries exactly ONE control (the split chevron is deleted) and
  that button spans the row inside the dock panel,
- the toolbar is THREE EQUAL SECTIONS: branch ▾ | Push | Fetch are within 1px
  of each other's width (`EQUAL-THIRDS`) at every dock width,
- the Push section shows its TEXT label, not an icon-only stub: at 380px and
  300px (`DESKTOP_UTILITY_DOCK_MIN_WIDTH`) `.dock-scm-remote-label` is rendered,
  UNCLIPPED, with more than two characters (`TEXT`); icon and label coexist at
  every width. The label degrades in whole pieces, never by truncation: the
  remote NAME goes below 420px (`Push origin` → `Push`). Ahead/behind lives on
  the TOP-RIGHT CORNER of the button that clears it — ahead on Push, behind on
  Fetch, so a diverged branch never crowds one corner with both counts. Each
  badge hangs on its own section's corner, on the toolbar row, shows its digits
  (`99+` above 99) plus its own direction arrow, stays wider than it is tall
  and stays inside the dock panel; the old band under the toolbar must not come
  back. Below the 300px floor only gaps and side padding tighten — action
  icons stay 14px, nothing hides and nothing overlaps,
- the toolbar is marked `data-i18n-skip`, so branch names and the fixed
  `Push`/`Fetch` Git action labels remain unchanged in every UI language,
- the branch panel keeps ONE box across frames: its first frame (open, loading
  row visible) and its settled frame (branches listed) have the same height and
  the same position, on a fresh open AND on a cached reopen, and both reopen
  frames match the first open's settled height. The list owns a fixed height and
  scrolls internally, so arriving data can never resize the panel around it.
- the measured viewport really is the case's height (the short-window case
  cannot pass by shrinking a div),
- with the `:many` fixture the branch list OVERFLOWS and scrolls inside the
  panel (`scrollHeight > clientHeight`), stays contained in it, and the panel
  keeps the same stable box it has with four branches — the fixed four-row
  fixture never exercised scrolling.
- no toolbar label renders as a clipped 1–2 character stub.
- the old panel-header Fetch is absent, so Fetch appears exactly once in its
  fixed toolbar section.
- the search box is the TOP of the dock's control stack, not part of the list:
  Source Control renders the Search pane's control stack
  (`.workbench-explorer-search, .dock-scm-view-controls`, 27-search-review.css),
  so the Changes `Filter` box and the History `Search commits` box pay that
  stack's side inset — they land on the `Changes | History` bar's left/right
  edges and stay symmetric in the panel, at every dock width. They do NOT sit
  on the row edges: the rows below the stack's hairline keep the list's own
  `--dock-scm-gutter` plus scrollbar reserve, which is a smaller inset,
- and both dock boxes are ONE component: rendered from the shared
  `.workbench-search-input` rule (the Search pane's `Search files` box is the
  reference shape), they agree within 1px on height, inner padding, hairline
  width, corner radius, the leading glyph's inset and box, and where the text
  starts — a panel that restyles its own field fails here. The Search pane's
  own box is out of this probe's reach (it mounts `SourceControlDock` only);
  it is covered by reading the shared rule instead.
- the left edge is ONE column: the `N changed files` select-all header checkbox
  and every row checkbox share the same x (`--dock-scm-row-inset`) and the same
  checkbox box width, at every dock width.
- the changed-file path column keeps its FILE NAME: at every dock width (300px
  and the reported 290px included) `.dock-scm-file-name` renders the path's
  basename in full, is not clipped (`scrollWidth <= clientWidth`) and stays
  inside `.dock-scm-file-copy` — only the dim directory prefix may lose
  characters to `…` (ScmPathText).
- neither list carries a PAGER: no `.dock-scm-load-more`, no `Show N more` and
  no `Load more` button exists, at any width or fixture, and the changed-file
  row keeps its 29px band (the height the window is computed on).
- with the `:rows` fixture both lists are WINDOWED and honest about it:
  `.dock-scm-scroll`'s scroll height is `2000 × 29px` plus its own padding
  (so the scrollbar and every scroll position describe the whole set) while at
  most 40 `.dock-scm-file` rows are mounted, before and after scrolling; the
  container really scrolls to its own end and the LAST of the 2000 files is
  rendered there — reachable by scrolling alone. The history does the same and
  pages itself from the scroll position: scrolling to the end requests
  `gitLog` skips 40 and 80 with no button involved, keeps at most 30 commit
  rows mounted and keeps scrolling inside its container.

It also measures the History surface, which has the same "no layout engine in
jsdom" problem:

- `Changes | History` are two EQUAL halves that span the tab bar edge to edge
  with the segmented control's single 4px gap between them, and the bar shares
  the search box's inset as the stack's lower member (`EQUAL SPANS-BAR
  ON-STACK`),
- every history row keeps ONE fixed height with no wrapped title or byline
  (`FIXED no-wrap`) and no commit-graph rail (`no-rail`) — long subjects and
  ref badges ellipsize inside the row instead of growing it. The rows carry no
  author monogram; an unpushed row ends in the round push button
  (`unpushed=true`), which must not change the row height either,
- the commit detail header stays inside the panel with its subject inside the
  two-line clamp (`.dock-scm-commit-headline > b`), and its meta row really
  carries the content it advertises: a non-blank unwrapped author and a hex
  short SHA, with a copy button that is at least 12x12 and inside the header —
  copying lives in the header's action cluster beside Back, not on the byline
  SHA. The SHA is additionally asserted to be PAINTED (not `display:none` /
  `visibility:hidden` / `opacity:0`), at least 12x8, and contained in the meta
  row — text content alone survives a field hidden by CSS. The commit lists its
  changed files as rows; the `+adds −dels` totals and the `N changed files`
  line are gone from the product on purpose (the two-tier header was retired in
  fc59fa078 / 28b8bd435) and are not measured.

Not covered: colours, hover/focus states, the diff bodies behind each file row
and the clipboard write itself — the probe measures layout and rendered text.

`probe.bundle.js` and `*.report.json` are generated (see `.gitignore`).
