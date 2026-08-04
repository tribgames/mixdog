/** Summarises a probe report AND asserts every geometry rule the dock has to
 *  keep. Prints one line per surface, then exits NONZERO on any violation, so
 *  the probe is a check and not a wall of text nobody reads. */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const report = JSON.parse(readFileSync(file, "utf8"));
const failures = [];
const check = (scenario, ok, message) => {
  if (!ok) failures.push(`dock ${scenario.dockWidth}px: ${message}`);
  return ok;
};
const box = (rect) => rect
  ? `x:${rect.left}..${rect.right} y:${rect.top}..${rect.bottom} (${rect.width}x${rect.height})`
  : "not rendered";
const contains = (child, parent) => Boolean(child) && Boolean(parent)
  && child.left >= parent.left - 0.5 && child.right <= parent.right + 0.5
  && child.top >= parent.top - 0.5 && child.bottom <= parent.bottom + 0.5;
const inside = (child, parent, label) => {
  if (!child || !parent) return `${label}: n/a`;
  return `${label}: ${contains(child, parent) ? "INSIDE" : "OUTSIDE"}`;
};
/** Two boxes whose LEFT and RIGHT edges land on the same pixels. */
const sameEdges = (a, b) => Boolean(a) && Boolean(b)
  && Math.abs(a.left - b.left) <= 0.5 && Math.abs(a.right - b.right) <= 0.5;
/** Horizontal containment — the only axis a clipped path column shows on. */
const withinX = (child, parent) => Boolean(child) && Boolean(parent)
  && child.left >= parent.left - 0.5 && child.right <= parent.right + 0.5;
const edgeGap = (a, b) => a && b
  ? `Δleft ${round(a.left - b.left)} Δright ${round(a.right - b.right)}`
  : "n/a";
const round = (value) => Math.round(value * 100) / 100;
/** A lineReport only carries a rectangle once it rendered; treat a text-only
 *  record as "no box" so geometry rules cannot pass on text content alone. */
const geo = (field) => (field && typeof field.left === "number" ? field : null);
/** Painted, hit-sized and inside its row — the same bar the copy button keeps. */
const shown = (field, parent) => Boolean(field?.rendered) && field.visible !== false
  && field.width >= 12 && field.height >= 8 && contains(geo(field), parent);

for (const scenario of report) {
  const viewport = {
    left: 0,
    top: 0,
    right: scenario.viewport.width,
    bottom: scenario.viewport.height,
  };
  console.log(`== dock ${scenario.dockWidth}px | window ${scenario.viewport.width}x${scenario.viewport.height} | shell ${scenario.shellHeight}px`);
  console.log(`   panel        ${box(scenario.panel)}`);
  console.log(`   branch panel ${box(scenario.branchPanel)}  ${inside(scenario.branchPanel, viewport, "window")}`);
  console.log(`   commit row   ${box(scenario.commitRow)} button ${box(scenario.commitButton)}`
    + ` controls=${scenario.commitControls}`);
  console.log(`   badge        ${box(scenario.badge)}`);

  // Every overlay is fully inside the window. The commit split menu is gone
  // with its chevron: the commit row must carry exactly ONE full-width
  // control, inside the panel.
  check(scenario, contains(scenario.branchPanel, viewport), "the branch panel leaves the window");
  check(scenario, scenario.commitControls === 1,
    `the commit row carries ${scenario.commitControls} control(s), not the single commit button`);
  check(scenario, contains(scenario.commitButton, scenario.panel),
    "the commit button leaves the dock panel");
  check(scenario, Boolean(scenario.commitRow) && Boolean(scenario.commitButton)
    && Math.abs(scenario.commitRow.width - scenario.commitButton.width) <= 1,
    `the commit button no longer spans its row (${scenario.commitButton?.width} in`
    + ` ${scenario.commitRow?.width})`);

  // The toolbar is THREE EQUAL SECTIONS (1:1:1), and the third one shows its
  // TEXT label — icon-only is the last resort, never the dock's normal state.
  const sections = scenario.toolbarSections || [];
  const widths = sections.map((section) => section.width);
  const spread = widths.length ? round(Math.max(...widths) - Math.min(...widths)) : Infinity;
  // textContent still carries a `display:none` remote NAME, so the VISIBLE
  // label is the verb plus whatever of the target survived.
  const labelText = (scenario.remoteVerb?.text || "").trim();
  console.log(`   toolbar      ${sections.map((section) =>
    `${section.kind.replace("dock-scm-toolbar-", "")}:${section.width}`).join(" ")}`
    + ` spread=${spread} ${spread <= 1 ? "EQUAL-THIRDS" : "UNEQUAL"}`);
  console.log(`   remote label visible="${labelText}" rendered=${Boolean(scenario.remoteLabel?.rendered)}`
    + ` clipped=${scenario.remoteLabel?.clipped} width=${scenario.remoteLabel?.width}`
    + ` icon=${scenario.remoteIcon}`
    + ` ${scenario.remoteLabel?.rendered ? "TEXT" : "ICON-ONLY"}`);
  check(scenario, sections.length === 3,
    `the toolbar measured ${sections.length} section(s), not project | branch | remote`);
  check(scenario, spread <= 1,
    `the toolbar sections are not within 1px of equal width (${widths.join(" / ")})`);
  check(scenario, Boolean(scenario.remoteLabel?.rendered) && labelText.length > 2,
    `the push/pull section renders icon-only (label "${labelText}",`
    + ` rendered=${Boolean(scenario.remoteLabel?.rendered)})`);
  check(scenario, scenario.remoteLabel?.clipped === false,
    `the push/pull label is clipped instead of degrading in whole pieces`
    + ` ("${labelText}" in ${scenario.remoteLabel?.width}px)`);
  check(scenario, scenario.remoteIcon === true,
    "the push/pull icon is missing — it must survive every degradation step");

  // The panel header's ALWAYS-AVAILABLE Fetch: hit-sized, inside the title
  // row, pinned at its right end and never overlapping the title.
  const headerFetch = scenario.headerFetch;
  const headerTitle = scenario.headerTitle;
  console.log(`   header fetch ${box(headerFetch)} title ${box(headerTitle)}`);
  check(scenario, Boolean(headerFetch) && headerFetch.width >= 16 && headerFetch.height >= 16,
    `the panel header's Fetch is missing or too small to hit (${box(headerFetch)})`);
  check(scenario, contains(headerFetch, scenario.headerRow),
    "the header Fetch leaves the panel header row");
  check(scenario, Boolean(headerFetch) && Boolean(headerTitle)
    && headerFetch.left >= headerTitle.right - 0.5,
    `the header Fetch overlaps the Source Control title`
    + ` (title ${box(headerTitle)} vs fetch ${box(headerFetch)})`);
  check(scenario, Boolean(headerFetch) && Boolean(scenario.headerRow)
    && scenario.headerRow.right - headerFetch.right <= 12,
    `the header Fetch is not pinned at the header row's right end`
    + ` (${round((scenario.headerRow?.right ?? 0) - (headerFetch?.right ?? 0))}px of slack)`);

  // The branch panel opens INSTANTLY with a loading row and fills one turn
  // later. Its box must not change between those frames: the list owns a
  // stable height and scrolls inside it, so the panel neither moves nor
  // resizes when the data lands (first open AND cached reopen).
  const firstFrame = scenario.branchPanelFirst;
  const settled = scenario.branchPanelSettled;
  const reopenFirst = scenario.branchPanelReopenFirst;
  const reopenSettled = scenario.branchPanelReopenSettled;
  console.log(`   branch frames first ${box(firstFrame)} (loading=${scenario.branchPanelFirstLoading})`
    + ` → settled ${box(settled)} rows=${scenario.branchRows}`);
  console.log(`   branch reopen first ${box(reopenFirst)} → settled ${box(reopenSettled)}`);
  const stable = (before, after, label) => {
    if (!check(scenario, Boolean(before) && Boolean(after),
      `${label}: the branch panel was not measured on both frames`)) return;
    check(scenario, Math.abs(before.height - after.height) <= 0.5,
      `${label}: the branch panel HEIGHT changes between its first and settled frames`
      + ` (${before.height} → ${after.height})`);
    check(scenario, Math.abs(before.top - after.top) <= 0.5
      && Math.abs(before.left - after.left) <= 0.5,
      `${label}: the branch panel MOVES between its first and settled frames`
      + ` (${box(before)} → ${box(after)})`);
  };
  stable(firstFrame, settled, "first open");
  stable(reopenFirst, reopenSettled, "cached reopen");
  check(scenario, Boolean(settled) && Boolean(reopenSettled)
    && Math.abs(settled.height - reopenSettled.height) <= 0.5,
    `a cached reopen resizes the panel (${settled?.height} vs ${reopenSettled?.height})`);
  check(scenario, scenario.branchPanelFirstLoading === true,
    "the first frame shows no loading feedback at all");
  check(scenario, (scenario.branchRows ?? 0) > 0,
    "the branch panel settled without listing a single branch");

  // The scenario's height is the WINDOW's height: a "short window" case that
  // only shrank #shell inside a 687px viewport never tested containment.
  const requested = scenario.requestedHeight ?? scenario.shellHeight;
  check(scenario, Math.abs(scenario.viewport.height - requested) <= 2,
    `the window is ${scenario.viewport.height}px tall, not the requested ${requested}px`
    + " — the short-window case must resize the real viewport, not a div inside it");

  // Branch LIST: it owns one height and scrolls inside the panel's box. Only
  // the many-branch fixture can prove it, so that scenario asserts the
  // overflow itself.
  const listScroll = scenario.branchListScroll;
  console.log(`   branch list  ${box(scenario.branchList)} rows=${scenario.branchRows}`
    + ` scroll=${listScroll ? `${listScroll.scrollHeight}/${listScroll.clientHeight}` : "n/a"}`
    + ` fixture=${scenario.branchMode || "few"}`);
  if (scenario.branchMode === "many") {
    check(scenario, (scenario.branchRows ?? 0) >= 20,
      `the many-branch scenario listed only ${scenario.branchRows} branch row(s)`);
    check(scenario, Boolean(listScroll?.scrollable),
      "the many-branch list does not scroll: it grew the panel instead of overflowing"
      + ` (${listScroll ? `${listScroll.scrollHeight} in ${listScroll.clientHeight}` : "not measured"})`);
    check(scenario, contains(scenario.branchList, scenario.branchPanel),
      `the branch list leaves the panel it scrolls inside of`
      + ` (${box(scenario.branchList)} vs ${box(scenario.branchPanel)})`);
  }

  for (const label of scenario.labels) {
    const name = label.selector.replace(/^.*[ >.]/, "");
    if (!label.rendered) {
      console.log(`   label ${name}: hidden (no stub)`);
      continue;
    }
    const stub = label.clipped && label.width < 30;
    console.log(`   label ${name}: "${label.text}" width=${label.width} full=${label.fullWidth} clipped=${label.clipped}${stub ? " STUB" : ""}`);
    check(scenario, !stub, `label ${name} renders as a clipped stub ("${label.text}")`);
  }

  // Changes | History must be two EQUAL halves spanning the panel width
  // (_tab-bar.scss:33-52, `flex: 1` per item).
  const tabs = scenario.tabs || [];
  if (!check(scenario, tabs.length === 2, `expected 2 tab halves, measured ${tabs.length}`)) {
    console.log(`   tab bar      MISSING (${tabs.length} halves)`);
  } else {
    const halves = tabs.map((tab) => tab.width);
    const equal = Math.abs(halves[0] - halves[1]) <= 1;
    const span = scenario.tabBar
      && Math.abs(halves.reduce((sum, value) => sum + value, 0) - scenario.tabBar.width) <= 1;
    const full = scenario.tabBar && scenario.panel
      && Math.abs(scenario.tabBar.width - scenario.panel.width) <= 1;
    console.log(`   tab bar      ${box(scenario.tabBar)}  halves=${halves.join(" / ")}`
      + ` ${equal ? "EQUAL" : "UNEQUAL"} ${span ? "SPANS-BAR" : "GAP"} ${full ? "FULL-WIDTH" : "NARROW"}`);
    check(scenario, equal, `the tab halves are unequal (${halves.join(" / ")})`);
    check(scenario, span, "the tab halves do not fill the tab bar");
    check(scenario, full, "the tab bar does not span the panel width");
    check(scenario, ["changes", "history"].every((id, index) => tabs[index]?.option === id),
      "the tab bar does not read Changes | History in order");
    for (const tab of tabs) {
      const wrapped = tab.label?.wrapped ? " WRAPPED" : "";
      const clipped = tab.label?.clipped ? " CLIPPED" : "";
      console.log(`     tab ${tab.option}: "${tab.label?.text}" width=${tab.width} h=${tab.height}${wrapped}${clipped}`);
      check(scenario, !tab.label?.wrapped, `the ${tab.option} tab label wraps`);
      check(scenario, !tab.label?.clipped, `the ${tab.option} tab label is clipped`);
    }
  }

  // History rows: one fixed height, never a wrapped title or byline, and no
  // commit-graph rail (commit-list-item.tsx has none).
  const rows = scenario.historyRows || [];
  if (!check(scenario, rows.length > 0, "no history rows were measured")) {
    console.log("   history rows MISSING");
  } else {
    const heights = [...new Set(rows.map((row) => row.height))];
    const wrapped = rows.filter((row) => row.title?.wrapped || row.byline?.wrapped);
    const rails = rows.filter((row) => row.graphRail);
    console.log(`   history rows ${rows.length} rows heights=${heights.join(",")}`
      + ` ${heights.length === 1 ? "FIXED" : "RAGGED"}`
      + ` ${wrapped.length ? `WRAPPED(${wrapped.length})` : "no-wrap"}`
      + ` ${rails.length ? `GRAPH-RAIL(${rails.length})` : "no-rail"}`);
    check(scenario, heights.length === 1,
      `history rows have ragged heights (${heights.join(", ")})`);
    check(scenario, wrapped.length === 0,
      `${wrapped.length} history row(s) wrap their title or byline`);
    check(scenario, rails.length === 0,
      `${rails.length} history row(s) still draw a commit-graph rail`);
    for (const row of rows) {
      console.log(`     row ${row.index}: h=${row.height} title="${row.title?.text}"`
        + ` titleClipped=${row.title?.clipped} byline="${row.byline?.text}"`
        + ` refs=${row.refs ? row.refs.width : 0} unpushed=${row.unpushed}`);
      check(scenario, row.title?.rendered && row.byline?.rendered,
        `history row ${row.index} is missing its title or byline`);
      check(scenario, !row.overflows,
        `history row ${row.index} overflows its own width`);
      check(scenario, Boolean(scenario.panel) && row.right <= scenario.panel.right + 0.5,
        `history row ${row.index} runs past the panel's right edge`);
    }
  }

  if (!check(scenario, Boolean(scenario.commitHeader), "the commit detail header did not render")) {
    console.log("   commit head  MISSING");
  } else {
    // The header's real CONTENT and geometry: a container that renders while
    // its copy control is zero-sized, or with a blank author / missing SHA /
    // missing totals, used to pass on existence alone.
    const meta = scenario.commitHeaderMeta;
    const copy = scenario.commitCopy;
    const author = scenario.commitHeaderAuthor;
    const sha = (scenario.commitHeaderSha?.text || "").trim();
    const totals = (scenario.commitHeaderTotals?.text || "").trim();
    const filesText = (scenario.commitFilesHeader?.text || "").trim();
    const counted = /^(\d+) changed files?$/.exec(filesText);
    const fileRows = scenario.commitFileRows ?? 0;
    console.log(`   commit head  ${box(scenario.commitHeader)}  ${inside(scenario.commitHeader, scenario.panel, "panel")}`);
    console.log(`     title "${scenario.commitHeaderTitle?.text}" h=${scenario.commitHeaderTitle?.height}`
      + ` wrapped=${scenario.commitHeaderTitle?.wrapped}`);
    console.log(`     meta ${box(meta)}  ${inside(meta, scenario.commitHeader, "header")}`);
    console.log(`     author "${author?.text}" wrapped=${author?.wrapped}`
      + ` sha "${sha}" totals "${totals}"`);
    console.log(`     sha    ${box(geo(scenario.commitHeaderSha))}`
      + `  ${inside(geo(scenario.commitHeaderSha), meta, "meta")}`
      + ` visible=${scenario.commitHeaderSha?.visible}`);
    console.log(`     totals ${box(geo(scenario.commitHeaderTotals))}`
      + `  ${inside(geo(scenario.commitHeaderTotals), meta, "meta")}`
      + ` visible=${scenario.commitHeaderTotals?.visible}`);
    console.log(`     copy ${box(copy)}  ${inside(copy, meta, "meta")}`);
    console.log(`     files "${filesText}" rows=${fileRows}`);
    check(scenario, contains(scenario.commitHeader, scenario.panel),
      "the commit detail header leaves the dock panel");
    check(scenario, scenario.commitHeaderTitle?.rendered
      && !scenario.commitHeaderTitle?.wrapped, "the commit detail title wraps or is missing");
    check(scenario, Boolean(meta) && contains(meta, scenario.commitHeader),
      "the commit detail meta row is missing or leaves the header");
    check(scenario, Boolean(author?.rendered) && author.text.trim().length > 0,
      `the commit detail author is missing or blank ("${author?.text || ""}")`);
    check(scenario, !author?.wrapped, "the commit detail author wraps its line");
    check(scenario, /^[0-9a-f]{7,40}$/.test(sha),
      `the commit detail short SHA reads "${sha}"`);
    // Text content is not proof of a visible field: a SHA hidden by CSS (or
    // clipped out of the meta row) still reads correctly from `textContent`.
    check(scenario, shown(scenario.commitHeaderSha, meta),
      `the commit detail short SHA is not visibly rendered inside the meta row`
      + ` (${box(geo(scenario.commitHeaderSha))} visible=${scenario.commitHeaderSha?.visible})`);
    // A copy button styled to 0x0 (or clipped out of the meta row) is not a
    // control the user can hit: the SHA would be uncopyable in silence.
    check(scenario, Boolean(copy) && copy.width >= 12 && copy.height >= 12,
      `the SHA copy button is missing or too small to click (${box(copy)})`);
    check(scenario, contains(copy, meta), "the SHA copy button leaves the meta row");
    check(scenario, /^\+\d+\s*−\d+$/.test(totals),
      `the +adds −dels totals read "${totals}"`);
    check(scenario, shown(scenario.commitHeaderTotals, meta),
      `the +adds −dels totals are not visibly rendered inside the meta row`
      + ` (${box(geo(scenario.commitHeaderTotals))} visible=${scenario.commitHeaderTotals?.visible})`);
    check(scenario, Boolean(counted), `the changed-files header reads "${filesText}"`);
    check(scenario, fileRows > 0, "the commit detail lists no changed files at all");
    check(scenario, Boolean(counted) && Number(counted[1]) === fileRows,
      `the changed-files header counts ${counted ? counted[1] : "?"} but ${fileRows} file row(s) render`);
  }

  // The search/filter box is part of the LIST, not a floating field: its left
  // and right edges land on the row edges below it (the dock gutter plus the
  // scrollbar reserve the rows already account for).
  console.log(`   changes box  ${box(scenario.changesFilter)}`
    + ` vs file row ${box(scenario.changesRow)}  ${edgeGap(scenario.changesFilter, scenario.changesRow)}`);
  console.log(`   history box  ${box(scenario.historySearch)}`
    + ` vs commit row ${box(scenario.historyRow)}  ${edgeGap(scenario.historySearch, scenario.historyRow)}`);
  check(scenario, sameEdges(scenario.changesFilter, scenario.changesRow),
    `the Changes filter box does not share the file rows' edges`
    + ` (${box(scenario.changesFilter)} vs ${box(scenario.changesRow)})`);
  check(scenario, sameEdges(scenario.historySearch, scenario.historyRow),
    `the History search box does not share the commit rows' edges`
    + ` (${box(scenario.historySearch)} vs ${box(scenario.historyRow)})`);

  // ONE component grammar: both dock boxes render from .workbench-search-input,
  // so they agree on height, padding, hairline, radius, glyph box and where
  // the text starts — no panel may restyle its own field.
  const insets = (field) => field
    ? `h=${field.height} pad=${field.paddingLeft}/${field.paddingRight}`
      + ` border=${field.borderWidth} r=${field.radius}`
      + ` icon=${field.iconInset}+${field.iconWidth} text=${field.textInset}`
    : "not rendered";
  console.log(`   search grammar changes ${insets(scenario.changesFilter)}`);
  console.log(`   search grammar history ${insets(scenario.historySearch)}`);
  for (const key of ["height", "paddingLeft", "paddingRight", "borderWidth",
    "radius", "iconInset", "iconWidth", "textInset"]) {
    const changes = scenario.changesFilter?.[key];
    const history = scenario.historySearch?.[key];
    check(scenario,
      typeof changes === "number" && typeof history === "number"
      && Math.abs(changes - history) <= 1,
      `the Changes and History search boxes are not the same box: ${key}`
      + ` ${changes} vs ${history}`);
  }

  // Path truncation keeps the FILE NAME (path-text.tsx:188-227): the dim
  // directory prefix is the only part allowed to lose characters, so the name
  // is never ellipsized, never clipped and never overflows its path column —
  // at 300px (DESKTOP_UTILITY_DOCK_MIN_WIDTH) and at the reported 290px too.
  const changedFiles = scenario.changesFiles || [];
  check(scenario, changedFiles.length > 0, "no changed-file path columns were measured");
  for (const entry of changedFiles) {
    const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const name = geo(entry.name);
    console.log(`   file ${entry.index}: "${entry.directory?.text || ""}" + "${entry.name?.text || ""}"`
      + ` name=${box(name)} column=${box(entry.copy)}`
      + ` clipped=${entry.name?.clipped} tooltip="${entry.tooltip}"`);
    check(scenario, Boolean(entry.name?.rendered),
      `file row ${entry.index} renders no file name at all`);
    check(scenario, entry.name?.text === base,
      `file row ${entry.index} lost its file name ("${entry.name?.text}" instead of "${base}")`);
    check(scenario, !entry.name?.clipped,
      `file row ${entry.index}'s file name is clipped ("${entry.name?.text}")`);
    check(scenario, withinX(name, entry.copy),
      `file row ${entry.index}'s file name overflows its path column`
      + ` (${box(name)} vs ${box(entry.copy)})`);
  }

  // ONE checkbox column: the `N changed files` select-all header checkbox and
  // every row checkbox share the same x and the same box width, so the list's
  // left edge reads as a single column instead of two staggered insets.
  const headerCheck = scenario.checkAll;
  const rowChecks = scenario.rowChecks || [];
  console.log(`   check column header ${box(headerCheck)} rows=${rowChecks.length}`
    + ` Δleft ${rowChecks.map((row) => round(row.left - (headerCheck?.left ?? 0))).join(",") || "n/a"}`);
  check(scenario, Boolean(headerCheck), "the select-all header checkbox did not render");
  check(scenario, rowChecks.length > 0, "no changed-file row checkboxes were measured");
  rowChecks.forEach((row, index) => {
    check(scenario, Boolean(headerCheck) && Math.abs(row.left - headerCheck.left) <= 0.5,
      `file row ${index}'s checkbox is off the header checkbox's x column`
      + ` (Δleft ${round(row.left - (headerCheck?.left ?? 0))})`);
    check(scenario, Boolean(headerCheck) && Math.abs(row.width - headerCheck.width) <= 0.5,
      `file row ${index}'s checkbox box width differs from the header's`
      + ` (${row.width} vs ${headerCheck?.width})`);
  });

  // WINDOWED lists: `Show N more` / `Load more` are gone, so scrolling is the
  // only way to reach the end of either list — which only works if the scroll
  // container carries the FULL row count's height while a window of rows is
  // mounted (SourceControlDock `useRowWindow`).
  const changesScroll = scenario.changesScroll;
  const changesEnd = scenario.changesScrollEnd;
  const rowHeight = scenario.changesRowHeight ?? 0;
  console.log(`   changes list fixture=${scenario.rowMode || "few"}`
    + ` rendered=${scenario.changesRendered}/${scenario.changesTotal} rowH=${rowHeight}`
    + ` scroll=${changesScroll ? `${changesScroll.scrollHeight}/${changesScroll.clientHeight}` : "n/a"}`
    + ` spacers=${changesScroll?.spacers?.join("+") ?? "n/a"}`
    + ` pagers=${scenario.pagerControls}`);
  check(scenario, scenario.pagerControls === 0,
    `the lists still render ${scenario.pagerControls} pager control(s)`
    + " — every row must be reachable by SCROLLING");
  check(scenario, Math.abs(rowHeight - 29) <= 0.5,
    `the changed-file row band is ${rowHeight}px, not the 29px the window is computed on`);
  const historyScroll = scenario.historyScroll;
  console.log(`   history list rendered=${scenario.historyRendered}`
    + ` scroll=${historyScroll ? `${historyScroll.scrollHeight}/${historyScroll.clientHeight}` : "n/a"}`
    + ` spacers=${historyScroll?.spacers?.join("+") ?? "n/a"}`
    + ` skips=${(scenario.historySkips || []).join(",") || "none"}`);
  if (scenario.rowMode === "many") {
    const total = scenario.changesTotal ?? 0;
    const expected = total * rowHeight + (changesScroll?.padding ?? 0);
    console.log(`   many rows    end scroll=${changesEnd ? `${changesEnd.scrollTop}+${changesEnd.clientHeight}/${changesEnd.scrollHeight}` : "n/a"}`
      + ` rendered=${scenario.changesRenderedEnd} last="${scenario.changesLastRendered}"`);
    console.log(`   many commits end scroll=${scenario.historyScrollEnd
      ? `${scenario.historyScrollEnd.scrollHeight}/${scenario.historyScrollEnd.clientHeight}` : "n/a"}`
      + ` rendered=${scenario.historyRenderedEnd} skips=${(scenario.historySkips || []).join(",")}`);
    check(scenario, Boolean(changesScroll)
      && Math.abs(changesScroll.scrollHeight - expected) <= 2,
      `the changed-file list's scroll height is ${changesScroll?.scrollHeight}, not the`
      + ` ${expected} its ${total} rows describe — the scrollbar lies about the list`);
    check(scenario, Boolean(changesScroll?.scrollable),
      "the changed-file list does not scroll at all with 2000 rows");
    check(scenario, (scenario.changesRendered ?? 0) > 0
      && (scenario.changesRendered ?? 0) <= 40,
      `${scenario.changesRendered} of ${total} rows are mounted — the list is not windowed`);
    check(scenario, (scenario.changesRenderedEnd ?? 0) > 0
      && (scenario.changesRenderedEnd ?? 0) <= 40,
      `${scenario.changesRenderedEnd} rows are mounted at the end of the list`);
    check(scenario, Boolean(changesEnd)
      && Math.abs(changesEnd.scrollHeight - expected) <= 2,
      `scrolling to the end changed the list's scroll height (${changesEnd?.scrollHeight}`
      + ` vs ${expected})`);
    check(scenario, Boolean(changesEnd)
      && changesEnd.scrollTop + changesEnd.clientHeight >= changesEnd.scrollHeight - 2,
      "the changed-file list cannot be scrolled to its own end");
    check(scenario, scenario.changesLastRendered === scenario.changesLastExpected,
      `the last changed file is not reachable by scrolling`
      + ` ("${scenario.changesLastRendered}" instead of "${scenario.changesLastExpected}")`);
    // History pages from the SCROLL POSITION now: page 2 and 3 must have been
    // requested without any button being pressed.
    const skips = scenario.historySkips || [];
    check(scenario, skips.includes(40) && skips.includes(80),
      `scrolling the history fetched skips [${skips.join(",")}] — the scroll pager`
      + " never asked for the next pages");
    check(scenario, (scenario.historyRenderedEnd ?? 0) > 0
      && (scenario.historyRenderedEnd ?? 0) <= 30,
      `${scenario.historyRenderedEnd} commit rows are mounted — the history is not windowed`);
    check(scenario, scenario.historyPagerControls === 0,
      `the history still renders ${scenario.historyPagerControls} Load more control(s)`);
    check(scenario, Boolean(scenario.historyScrollEnd?.scrollable),
      "the paged history does not scroll inside its container");
  }
}

if (failures.length) {
  console.log(`\nFAIL (${failures.length}):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nOK: ${report.length} scenario(s), every geometry rule holds.`);
}
