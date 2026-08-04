/** Real-Chromium geometry probe for the Source Control dock overlays.
 *  jsdom has no layout engine, so overlay clamping (branch panel, remote
 *  dropdown, commit split menu) and label degradation are measured HERE, in
 *  the same Chromium that ships in Electron, against the real stylesheets. */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenSelect } from "../../src/renderer/OpenSelect";
import { SourceControlDock } from "../../src/renderer/SourceControlDock";
import type { DesktopGitFile, DesktopGitStatus } from "../../src/shared/contract";

const changedFile = (path: string, overrides: Partial<DesktopGitFile> = {}): DesktopGitFile => ({
  path,
  index: " ",
  worktree: "M",
  untracked: false,
  conflicted: false,
  stagedAdditions: 0,
  stagedDeletions: 0,
  unstagedAdditions: 1,
  unstagedDeletions: 0,
  additions: 1,
  deletions: 0,
  ...overrides,
});

const status: DesktopGitStatus = {
  repository: true,
  branch: "feature/source-control-overlays",
  detached: false,
  unborn: false,
  upstream: true,
  upstreamName: "origin/feature/source-control-overlays",
  remote: true,
  remoteUrl: "https://github.com/example/project.git",
  ahead: 2,
  behind: 1,
  operation: "",
  files: [
    changedFile("apps/desktop/src/renderer/SourceControlDock.tsx"),
    changedFile("apps/desktop/src/renderer/desktop.css"),
    changedFile("apps/desktop/src/renderer/UtilityDock.tsx"),
    changedFile("docs/notes.md", { index: "M", worktree: " " }),
    changedFile("generated/cache.txt", { index: "?", worktree: "?", untracked: true }),
  ],
};

/** The list a real repository hands the dock after a big refactor or a
 *  generated-tree change. `Show N more` is gone, so this fixture is what
 *  proves the whole set is SCROLLABLE: the scroll height has to describe all
 *  2000 rows while only a window of them is mounted. */
const MANY_FILES = Array.from({ length: 2000 }, (_, index) =>
  changedFile(
    `apps/desktop/src/renderer/generated/section-${String(Math.floor(index / 50)).padStart(2, "0")}`
    + `/module-${String(index).padStart(4, "0")}.tsx`,
    index % 7 === 0 ? { index: "M", worktree: " " } : {},
  ));
const manyStatus: DesktopGitStatus = { ...status, files: MANY_FILES };
/** …and the history that goes with it: `gitLog` pages it with skip/limit, so
 *  scrolling — not a `Load more` button — is what fetches page 2 and 3. */
const MANY_COMMITS = Array.from({ length: 120 }, (_, index) => ({
  hash: `${String(index).padStart(4, "0")}aaaaaaaaaaaabbbbbbbbbbbbcccc`,
  shortHash: `${String(index).padStart(4, "0")}aaa`,
  subject: `Generated commit number ${index} on the windowed history surface`,
  author: index % 3 === 0 ? "Ada Lovelace" : "Grace Hopper",
  when: `${index + 1} minutes ago`,
  authoredAt: "2026-07-31T09:12:00.000Z",
  pushed: true,
  parents: [] as string[],
  refs: [] as string[],
}));
/** Switched per scenario by `measure`, exactly like `branchMode`. */
let rowMode: "few" | "many" = "few";
/** Every `gitLog` skip the surface asked for in the current scenario. */
const gitLogSkips: number[] = [];
let applyRowMode: (mode: "few" | "many") => void = () => {};

/** The four-row fixture every geometry rule was written against… */
const BASE_BRANCHES = [
  { name: "main", current: false, remote: false, upstream: "origin/main", lastCommitRelative: "2 days ago" },
  {
    name: "feature/source-control-overlays",
    current: true,
    remote: false,
    upstream: "origin/feature/source-control-overlays",
    lastCommitRelative: "3 minutes ago",
  },
  { name: "release/2026.02", current: false, remote: false, upstream: "", lastCommitRelative: "3 weeks ago" },
  { name: "origin/main", current: false, remote: true, upstream: "", lastCommitRelative: "2 days ago" },
];
/** …and the one a real repository has: far more branches than the panel can
 *  show. Only an OVERFLOWING list can prove the list scrolls INSIDE the panel
 *  box (_branches.scss grammar, desktop.css `.dock-scm-branch-list`) instead of
 *  growing the panel past the window — which the four-row fixture never
 *  exercised. */
const MANY_BRANCHES = [
  ...BASE_BRANCHES,
  ...Array.from({ length: 36 }, (_, index) => ({
    name: `feature/generated/long-branch-name-${String(index + 1).padStart(2, "0")}`,
    current: false,
    remote: index % 4 === 3,
    upstream: "",
    lastCommitRelative: `${index + 1} days ago`,
  })),
];
/** Switched per scenario by `measure`. */
let branchMode: "few" | "many" = "few";

(window as unknown as { mixdogDesktop: unknown }).mixdogDesktop = {
  gitStatus: async () => (rowMode === "many" ? manyStatus : status),
  // History surface: long subjects, ref badges and an unpushed head — the
  // exact content that used to wrap the rows into 3-4 lines.
  gitLog: async (_cwd: string, _query: string, skip = 0, limit = 40) => {
    gitLogSkips.push(skip);
    if (rowMode === "many") return MANY_COMMITS.slice(skip, skip + limit);
    return [
    {
      hash: "aaaaaaaaaaaabbbbbbbbbbbbccccccccccccdddd",
      shortHash: "aaaaaaa",
      subject: "Port the History surface of the Source Control dock to GitHub Desktop's grammar",
      author: "Ada Lovelace",
      when: "2 minutes ago",
      authoredAt: "2026-07-31T09:12:00.000Z",
      pushed: false,
      parents: ["bbbbbbbbbbbb"],
      refs: ["main", "origin/main", "v0.9.87"],
    },
    {
      hash: "bbbbbbbbbbbbccccccccccccddddddddddddeeee",
      shortHash: "bbbbbbb",
      subject: "Rewrite the changed-files list with the flat checkbox grammar",
      author: "Grace Hopper",
      when: "3 hours ago",
      authoredAt: "2026-07-31T06:00:00.000Z",
      pushed: true,
      parents: ["cccccccccccc"],
      refs: [],
    },
    {
      hash: "ccccccccccccddddddddddddeeeeeeeeeeeeffff",
      shortHash: "ccccccc",
      subject: "Fix",
      author: "mixdog-bot",
      when: "yesterday",
      authoredAt: "2026-07-30T10:00:00.000Z",
      pushed: true,
      parents: [],
      refs: ["release/2026.02"],
    },
    ];
  },
  gitShow: async (_cwd: string, hash: string) => ({
    hash,
    shortHash: hash.slice(0, 7),
    subject: "Port the History surface of the Source Control dock to GitHub Desktop's grammar",
    author: "Ada Lovelace",
    email: "ada@example.com",
    authoredAt: "2026-07-31T09:12:00.000Z",
    parents: ["bbbbbbbbbbbb"],
    files: [
      { path: "apps/desktop/src/renderer/SourceControlDock.tsx", status: "M", additions: 132, deletions: 96 },
      { path: "apps/desktop/src/renderer/desktop.css", status: "M", additions: 74, deletions: 48 },
    ],
  }),
  // A REAL round trip, not an already-resolved promise: the branch panel opens
  // instantly and its rows land one IPC later, which is exactly the sequence
  // the panel's height has to survive.
  gitBranches: async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return branchMode === "many" ? MANY_BRANCHES : BASE_BRANCHES;
  },
  gitMergeBranch: async () => "",
  gitStage: async () => {},
  gitUnstage: async () => {},
  gitCommit: async () => "",
  gitFetch: async () => "",
  gitPull: async () => "",
  gitPush: async () => "",
};

function Probe() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [rows, setRows] = useState<"few" | "many">("few");
  useEffect(() => {
    applyRowMode = setRows;
  }, []);
  return <>
    <header className="utility-dock-header" data-panel-header="source-control">
      <div className="utility-dock-title"><b>Source Control</b></div>
      <span className="utility-dock-header-actions utility-dock-scm-actions" ref={setSlot} />
    </header>
    <SourceControlDock
      projectPath="C:\\work\\mixdog"
      status={rows === "many" ? manyStatus : status}
      statusReady={true}
      loading={false}
      statusError=""
      onRefreshStatus={async () => {}}
      headerSlot={slot}
      active={true}
      readinessKey="probe"
      onReadyChange={() => {}}
      projectSelect={<OpenSelect ariaLabel="Switch project" className="dock-project-select"
        value="C:\\work\\mixdog"
        options={[
          { value: "C:\\work\\mixdog", label: "mixdog" },
          { value: "C:\\work\\other", label: "other" },
        ]}
        onChange={() => {}} />} />
  </>;
}

createRoot(document.getElementById("pane") as HTMLElement).render(<Probe />);

const frames = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(), 20)));
});
/** The first LAID-OUT frame after a discrete click: React commits the click's
 *  state in its own task, so one short timeout is enough — and unlike
 *  requestAnimationFrame it is not throttled in this hidden probe window (which
 *  would skip past the 80ms branch IPC and measure the settled panel twice).
 *  getBoundingClientRect below forces the layout itself. */
const nextFrame = async () => {
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 16));
};
/** Past the branch IPC's round trip, then two more frames. */
const settleFrames = async () => {
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
  await frames();
};

const round = (value: number) => Math.round(value * 100) / 100;

const rectOf = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: round(rect.left),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    width: round(rect.width),
    height: round(rect.height),
  };
};

const click = async (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`probe: missing ${selector}`);
  element.click();
  await frames();
};

const labelReport = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return { selector, rendered: false };
  const rect = element.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0;
  return {
    selector,
    rendered: visible,
    text: element.textContent || "",
    width: round(rect.width),
    // A truncated label whose box is narrower than a few glyphs is the "P."
    // stub the user reported.
    clipped: element.scrollWidth > element.clientWidth + 1,
    fullWidth: element.scrollWidth,
  };
};

const rectIn = (row: Element, selector: string) => {
  const element = row.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { left: round(rect.left), top: round(rect.top), right: round(rect.right),
    bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) };
};

/** A search/filter box PLUS the insets that make it one component: the box
 *  rectangle (so the row-edge rules keep working), its painted height, its
 *  own padding/border and where the leading glyph and the text actually
 *  start. Two boxes rendered from the same rule agree on every field. */
const searchBoxReport = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const icon = rectIn(element, "svg");
  const field = rectIn(element, "input");
  const number = (value: string) => round(Number.parseFloat(value) || 0);
  return {
    left: round(rect.left),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    width: round(rect.width),
    height: round(rect.height),
    paddingLeft: number(style.paddingLeft),
    paddingRight: number(style.paddingRight),
    borderWidth: number(style.borderTopWidth),
    radius: number(style.borderTopLeftRadius),
    iconInset: icon ? round(icon.left - rect.left) : null,
    iconWidth: icon ? round(icon.width) : null,
    textInset: field ? round(field.left - rect.left) : null,
  };
};

/** A text box that must render on ONE line: reports its measured height and
 *  whether the content overflows it (the wrap/clip defect this port fixes),
 *  plus its rectangle and whether it is actually PAINTED — text content alone
 *  cannot tell a rendered field from one hidden by CSS. */
const lineReport = (element: Element | null, name: string) => {
  if (!element) return { name, rendered: false };
  const box = element as HTMLElement;
  const rect = box.getBoundingClientRect();
  const style = getComputedStyle(box);
  // `display:none` collapses the rect, but `visibility:hidden` / `opacity:0`
  // keep a full-sized box, so both signals are needed.
  const painted = style.display !== "none" && style.visibility !== "hidden"
    && Number(style.opacity || "1") > 0.01;
  return {
    name,
    rendered: rect.width > 0 && rect.height > 0,
    visible: rect.width > 0 && rect.height > 0 && painted,
    text: box.textContent || "",
    left: round(rect.left),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    width: round(rect.width),
    height: round(rect.height),
    // scrollHeight beyond the box height means the line wrapped.
    wrapped: box.scrollHeight > box.clientHeight + 1,
    clipped: box.scrollWidth > box.clientWidth + 1,
  };
};

/** The scroll geometry a WINDOWED list has to keep truthful: the container's
 *  own scroll height, where it currently sits, and the two spacers that stand
 *  in for the rows that are not mounted (SourceControlDock `useRowWindow`). */
const scrollMetrics = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) return null;
  const style = getComputedStyle(node);
  return {
    clientHeight: round(node.clientHeight),
    scrollHeight: round(node.scrollHeight),
    scrollTop: round(node.scrollTop),
    padding: round((parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)),
    spacers: [...node.querySelectorAll<HTMLElement>(".dock-scm-row-spacer")]
      .map((spacer) => round(spacer.getBoundingClientRect().height)),
    scrollable: node.scrollHeight > node.clientHeight + 1,
  };
};

/** Scrolls a list and waits for the window to re-render around the new
 *  position (and for any page it asks for on the way). */
const scrollList = async (selector: string, top: number) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`probe: missing ${selector}`);
  node.scrollTop = top;
  await frames();
  await frames();
  return node;
};

/** Every control the deleted pagers used to render. */
const pagerControls = () => document.querySelectorAll(".dock-scm-load-more").length
  + [...document.querySelectorAll("button")]
    .filter((button) => /^(Show \d+ more|Load more)$/.test((button.textContent || "").trim()))
    .length;

const measure = async (scenario: {
  width: number;
  height: number;
  branches?: "few" | "many";
  rows?: "few" | "many";
}) => {
  const { width, height } = scenario;
  branchMode = scenario.branches === "many" ? "many" : "few";
  // The changed-file / history fixtures are swapped through React state, so
  // the dock re-renders with the list the scenario asks for.
  rowMode = scenario.rows === "many" ? "many" : "few";
  gitLogSkips.length = 0;
  applyRowMode(rowMode);
  await frames();
  const dock = document.getElementById("dock") as HTMLElement;
  const shell = document.getElementById("shell") as HTMLElement;
  // The WINDOW is resized by the Electron shell (main.cjs sets the content
  // size per scenario), so the shell simply fills whatever height the real
  // viewport has: a short window is a short window, not a short div inside a
  // 687px one — branch-panel containment was never tested against a genuinely
  // short viewport before.
  shell.style.height = `${window.innerHeight}px`;
  // The dock carries its width as an inline custom property in the real app
  // (UtilityDock.tsx:1094-1095); the 300px floor is overridden so the probe
  // can also sit at the ~290px the user reported.
  dock.style.width = `${width}px`;
  dock.style.minWidth = `${width}px`;
  dock.style.setProperty("--utility-dock-width", `${width}px`);
  dock.style.setProperty("--utility-dock-min-width", `${width}px`);
  await frames();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const report: Record<string, unknown> = {
    dockWidth: width,
    shellHeight: height,
    requestedHeight: height,
    branchMode,
    viewport,
    dock: rectOf(".utility-dock"),
    panel: rectOf(".dock-source-control"),
    stage: rectOf(".dock-scm-view-stage"),
    toolbar: rectOf(".dock-scm-toolbar"),
    // The panel header's always-available Fetch: a real hit box, pinned at the
    // RIGHT END of the title row and never on top of the title itself.
    headerRow: rectOf(".utility-dock-header"),
    headerTitle: rectOf(".utility-dock-header .utility-dock-title"),
    headerFetch: rectOf(".dock-scm-header-fetch"),
    // The three toolbar sections must split the width EVENLY (1:1:1) and the
    // third one must show its TEXT label at the dock's normal widths — jsdom
    // can measure neither.
    toolbarSections: [...document.querySelectorAll(".dock-scm-toolbar-section")]
      .map((section) => {
        const rect = section.getBoundingClientRect();
        return {
          kind: [...section.classList].find((name) =>
            name.startsWith("dock-scm-toolbar-") && name !== "dock-scm-toolbar-section") || "",
          left: round(rect.left),
          right: round(rect.right),
          width: round(rect.width),
          height: round(rect.height),
        };
      }),
    remoteLabel: lineReport(document.querySelector(".dock-scm-remote-label"), "remote-label"),
    remoteVerb: lineReport(document.querySelector(".dock-scm-remote-verb"), "remote-verb"),
    remoteIcon: Boolean(document.querySelector(".dock-scm-remote-button > svg")),
    labels: [
      labelReport(".dock-scm-remote-button > span"),
      labelReport(".dock-scm-branch-button > span"),
      labelReport(".dock-project-select .mx-select-value"),
    ],
    badge: rectOf(".dock-scm-ahead-behind"),
    // Changes tab: the shared filter box must share the file rows' EDGES
    // (the dock gutter + the scrollbar reserve the rows sit inside of), and
    // it is the SAME component as the History box (height + insets).
    changesFilter: searchBoxReport(".dock-scm-filter"),
    changesRow: rectOf(".dock-scm-file"),
    // The select-all header checkbox and EVERY row checkbox must sit on one x
    // column: same gutter, same box width, so the left edge reads as one
    // column (jsdom cannot measure this either).
    checkAll: rectOf('.dock-scm-check-all input[type="checkbox"]'),
    rowChecks: [...document.querySelectorAll(".dock-scm-file-check")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: round(rect.left),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        width: round(rect.width),
        height: round(rect.height),
      };
    }),
    // Path truncation (ScmPathText, path-text.tsx:188-227): jsdom cannot tell
    // whether the FILE NAME survived the narrow dock, so the name box, the
    // path column it sits in and the tooltip are measured here.
    changesFiles: [...document.querySelectorAll(".dock-scm-file")].map((row, index) => ({
      index,
      path: row.querySelector(".dock-scm-file-main")?.getAttribute("title") || "",
      copy: rectIn(row, ".dock-scm-file-copy"),
      tooltip: row.querySelector(".dock-scm-file-copy")?.getAttribute("title") || "",
      name: lineReport(row.querySelector(".dock-scm-file-name"), "file-name"),
      directory: lineReport(row.querySelector(".dock-scm-file-path"), "file-directory"),
    })),
  };

  // The changed-file list is SCROLLED, never paged: no `Show N more` control
  // may exist, only a window of rows may be mounted, and the container's own
  // scroll height must describe the WHOLE set.
  report.rowMode = rowMode;
  report.changesTotal = (rowMode === "many" ? MANY_FILES : status.files).length;
  report.changesRendered = document.querySelectorAll(".dock-scm-file").length;
  report.changesRowHeight = rectOf(".dock-scm-file")?.height ?? 0;
  report.changesScroll = scrollMetrics(".dock-scm-scroll");
  report.pagerControls = pagerControls();
  if (rowMode === "many") {
    const list = await scrollList(".dock-scm-scroll", 10_000_000);
    report.changesScrollEnd = scrollMetrics(".dock-scm-scroll");
    report.changesRenderedEnd = document.querySelectorAll(".dock-scm-file").length;
    report.changesLastRendered = [...document.querySelectorAll(".dock-scm-file-main")]
      .at(-1)?.getAttribute("title") || "";
    report.changesLastExpected = MANY_FILES[MANY_FILES.length - 1].path;
    list.scrollTop = 0;
    await frames();
  }

  // Branch panel, FRAME BY FRAME. It opens instantly with a loading row and
  // the branches land one turn later; the panel must not resize when they do
  // (user: 패널이 튄다). Both the first open and a CACHED reopen are measured
  // on their first frame and again once settled.
  const openBranchPanel = () => {
    const trigger = document.querySelector<HTMLElement>(".dock-scm-branch-button");
    if (!trigger) throw new Error("probe: missing .dock-scm-branch-button");
    trigger.click();
  };
  openBranchPanel();
  await nextFrame();
  report.branchPanelFirst = rectOf(".dock-scm-branch-picker");
  report.branchPanelFirstLoading = Boolean(
    [...document.querySelectorAll(".dock-scm-branch-list > p")]
      .some((node) => (node.textContent || "").includes("Loading")));
  await settleFrames();
  report.branchPanelSettled = rectOf(".dock-scm-branch-picker");
  report.branchPanel = report.branchPanelSettled;
  report.branchTrigger = rectOf(".dock-scm-branch-button");
  report.branchRows = document.querySelectorAll(".dock-scm-branch-row").length;
  // The list owns ONE height and scrolls inside it; with the many-branch
  // fixture that overflow is what keeps the panel's box stable.
  report.branchList = rectOf(".dock-scm-branch-list");
  report.branchListScroll = (() => {
    const list = document.querySelector(".dock-scm-branch-list");
    if (!list) return null;
    return {
      clientHeight: round(list.clientHeight),
      scrollHeight: round(list.scrollHeight),
      scrollable: list.scrollHeight > list.clientHeight + 1,
    };
  })();
  await click(".dock-scm-branch-button");
  // Cached reopen: the branches are already in state, so the loading row and
  // the rows render together and then the loading row leaves.
  openBranchPanel();
  await nextFrame();
  report.branchPanelReopenFirst = rectOf(".dock-scm-branch-picker");
  await settleFrames();
  report.branchPanelReopenSettled = rectOf(".dock-scm-branch-picker");
  await click(".dock-scm-branch-button");

  // The commit split menu (and its chevron) is gone: the commit button is ONE
  // action, so the row is measured as the single full-width control it is.
  report.commitButton = rectOf(".dock-scm-commit-button");
  report.commitRow = rectOf(".dock-scm-commit-split");
  report.commitControls = document.querySelectorAll(".dock-scm-commit-split > button").length;

  // Tab bar: two EQUAL halves spanning the panel width (_tab-bar.scss:33-52).
  report.tabBar = rectOf(".dock-scm-tab-bar");
  report.tabs = [...document.querySelectorAll(".dock-scm-tab")].map((tab) => ({
    option: (tab as HTMLElement).dataset.reviewOption || "",
    ...(rectOf(`[data-review-option="${(tab as HTMLElement).dataset.reviewOption}"]`) || {}),
    label: lineReport(tab.querySelector(".dock-scm-tab-label"), "tab-label"),
    counter: rectOf(".dock-review-count"),
  }));

  // History rows: fixed height, one-line title, byline, trailing indicators.
  await click('[data-review-option="history"]');
  await frames();
  await frames();
  report.historyRows = [...document.querySelectorAll(".dock-scm-commit-row")].map((row, index) => ({
    index,
    ...(row.getBoundingClientRect
      ? {
        height: round(row.getBoundingClientRect().height),
        width: round(row.getBoundingClientRect().width),
        right: round(row.getBoundingClientRect().right),
      }
      : {}),
    overflows: row.scrollWidth > row.clientWidth + 1,
    title: lineReport(row.querySelector(".dock-scm-commit-info > b"), "title"),
    byline: lineReport(row.querySelector(".dock-scm-commit-info > small"), "byline"),
    refs: rectIn(row, ".dock-scm-refs"),
    unpushed: Boolean(row.querySelector(".dock-scm-unpushed")),
    graphRail: Boolean(row.querySelector("svg.dock-scm-graph")),
  }));
  // History tab: same rule for the sticky `Search commits` box.
  report.historySearch = searchBoxReport(".dock-scm-history-search > .workbench-search-input");
  report.historyRow = rectOf(".dock-scm-history .dock-scm-commit-row");
  report.historyRendered = document.querySelectorAll(".dock-scm-history .dock-scm-commit-row").length;
  report.historyScroll = scrollMetrics(".dock-scm-history");
  report.historySkips = [...gitLogSkips];
  if (rowMode === "many") {
    // Scrolling towards the end IS the pager now: the next `gitLog` page has
    // to arrive without a button, and the loaded set has to keep growing.
    const list = await scrollList(".dock-scm-history", 10_000_000);
    await settleFrames();
    await scrollList(".dock-scm-history", 10_000_000);
    await settleFrames();
    report.historyScrollEnd = scrollMetrics(".dock-scm-history");
    report.historyRenderedEnd = document.querySelectorAll(".dock-scm-history .dock-scm-commit-row").length;
    report.historySkips = [...gitLogSkips];
    report.historyPagerControls = pagerControls();
    list.scrollTop = 0;
    await frames();
  }

  // Commit detail header (title, author, short SHA + copy, totals).
  const firstRow = document.querySelector<HTMLElement>(".dock-scm-commit-row");
  if (firstRow) {
    firstRow.click();
    await frames();
    await frames();
  }
  report.commitHeader = rectOf(".dock-scm-commit-header");
  report.commitHeaderTitle = lineReport(
    document.querySelector(".dock-scm-commit-headline > b"), "detail-title");
  report.commitHeaderMeta = rectOf(".dock-scm-commit-meta");
  report.commitFilesHeader = lineReport(
    document.querySelector(".dock-scm-commit-files-header"), "changed-files");
  report.commitCopy = rectOf(".dock-scm-commit-copy");
  // The header's CONTENT, not just its boxes: author, short SHA and the
  // +adds/−dels totals, plus the file rows the `N changed files` line counts.
  report.commitHeaderAuthor = lineReport(
    document.querySelector(".dock-scm-commit-author > span"),
    "detail-author");
  report.commitHeaderSha = lineReport(
    document.querySelector(".dock-scm-commit-ref code"), "detail-sha");
  report.commitHeaderTotals = lineReport(
    document.querySelector(".dock-scm-commit-lines"), "detail-totals");
  report.commitFileRows = document.querySelectorAll(".dock-scm-commit-file").length;
  const back = document.querySelector<HTMLElement>(".dock-scm-commit-back");
  if (back) {
    back.click();
    await frames();
  }
  await click('[data-review-option="changes"]');
  return report;
};

(window as unknown as { __probe: unknown }).__probe = {
  async run(scenarios: Array<{
    width: number;
    height: number;
    branches?: "few" | "many";
    rows?: "few" | "many";
  }>) {
    const results = [];
    for (const scenario of scenarios) {
      results.push(await measure(scenario));
    }
    return results;
  },
};
