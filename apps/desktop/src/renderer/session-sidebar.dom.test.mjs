import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";

import { cleanupDom, installDom, root } from "./renderer-dom-test-harness.mjs";

const { SessionSidebar } = await import("./session-sidebar.tsx");
const { subscribeTabDrag } = await import("./tab-drag-bus.ts");

afterEach(cleanupDom);

const TOTAL_SESSIONS = 120;
const INITIAL_ROWS = 24;
const PAGE_ROWS = 32;

function makeSessions(count = TOTAL_SESSIONS, overrides = () => ({})) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `session-${index}`,
    preview: "",
    title: `Session ${index}`,
    updatedAt: 1_700_000_000_000 - index * 1000,
    activityAt: 1_700_000_000_000 - index * 1000,
    messageCount: 2,
    cwd: "C:\\work",
    classification: "task",
    projectPath: null,
    currentSession: false,
    ...overrides(index),
  }));
}

// Archived rows render their own section BELOW Recent: they push the scroller
// far from its own bottom without moving the Recent sentinel.
const withArchivedTail = () => [
  ...makeSessions(),
  ...makeSessions(40, (index) => ({
    id: `archived-${index}`, title: `Archived ${index}`, archived: true,
  })),
];

const callbacks = {
  onNewTask() {},
  onOpenStudio() {},
  onOpenFile() {},
  onNewTerminal() {},
  onResumeSession() {},
  async onRenameSession() {},
  async onArchiveSession() {},
  async onDeleteSession() {},
};

const renderSidebar = (overrides = {}) => React.createElement(SessionSidebar, {
  open: true,
  sessions: makeSessions(),
  sessionsReady: true,
  selection: { kind: "new" },
  ...callbacks,
  ...overrides,
});

const scrollerEl = () => document.querySelector(".session-sidebar-scroll.session-sidebar-surface");
const recentRowCount = () => document.querySelectorAll(".recent-session-list .session-row").length;
const sentinel = () => document.querySelector(".recent-session-list .session-list-sentinel");
const recentToggle = () => [...document.querySelectorAll(".sidebar-recent-heading")]
  .find((button) => /Recent/.test(button.textContent || ""));

/** JSDOM reports every box as 0×0, which would make any proximity check pass.
 *  Geometry is stated explicitly so "near" and "far" are real cases. */
function stubRect(element, { top = 0, bottom = 0 }) {
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }),
    configurable: true,
  });
}

function stubScrollMetrics(element, { scrollHeight, scrollTop, clientHeight }) {
  for (const [key, value] of Object.entries({ scrollHeight, scrollTop, clientHeight })) {
    Object.defineProperty(element, key, { value, configurable: true });
  }
}

function installRecentRowGeometry(scroller, initialScrollTop, rowHeight = 36) {
  let scrollTop = initialScrollTop;
  stubRect(scroller, { top: 0, bottom: 180 });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (value) => { scrollTop = Number(value); },
    configurable: true,
  });
  for (const row of scroller.querySelectorAll(".recent-session-list .session-row")) {
    Object.defineProperty(row, "getBoundingClientRect", {
      value: () => {
        const currentRows = [...scroller.querySelectorAll(".recent-session-list .session-row")];
        const index = currentRows.indexOf(row);
        const top = index * rowHeight - scrollTop;
        return {
          top,
          bottom: top + rowHeight,
          left: 0,
          right: 200,
          width: 200,
          height: rowHeight,
          x: 0,
          y: top,
        };
      },
      configurable: true,
    });
  }
  return {
    get scrollTop() { return scrollTop; },
    rowTop(sessionId) {
      return scroller.querySelector(`[data-session-id="${sessionId}"]`)
        ?.getBoundingClientRect().top;
    },
  };
}

/** Places the scroller viewport at 0..600 and the sentinel `distance` px below
 *  the viewport bottom, with a tall scroller whose OWN bottom is far away
 *  (the Archived tail): whole-scroller math would never page here. */
function placeSentinel(distance) {
  const scroller = scrollerEl();
  stubRect(scroller, { top: 0, bottom: 600 });
  stubScrollMetrics(scroller, { scrollHeight: 5000, scrollTop: 0, clientHeight: 600 });
  const end = sentinel();
  if (end) stubRect(end, { top: 600 + distance, bottom: 601 + distance });
  return scroller;
}

const fireScroll = async (scroller) => act(async () =>
  scroller.dispatchEvent(new window.Event("scroll", { bubbles: false })));

test("Sessions header exposes the pane create options from one boxed add menu", async () => {
  installDom();
  const calls = [];
  await act(async () => root.render(renderSidebar({
    onNewTask: () => calls.push("task"),
    onOpenStudio: () => calls.push("studio"),
    onOpenFile: () => calls.push("file"),
    onNewTerminal: () => calls.push("terminal"),
  })));

  const actions = document.querySelector(".session-panel-header-actions");
  const trigger = actions?.querySelector(".session-new-create");
  const menu = document.querySelector('.workspace-tab-new-menu[aria-label="Create tab"]');
  assert.ok(trigger);
  assert.equal(actions?.querySelectorAll(":scope > button").length, 1,
    "Studio must be folded into the single create control");
  assert.equal(menu?.hidden, true);
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')]
    .map((item) => item.textContent), ["New Task", "New Studio", "New File", "New Terminal"]);

  for (const [className, expected] of [
    [".session-new-task", "task"],
    [".session-new-studio", "studio"],
    [".session-new-file", "file"],
    [".session-new-terminal", "terminal"],
  ]) {
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(menu.hidden, false);
    await act(async () => menu.querySelector(className).click());
    assert.equal(menu.hidden, true);
    assert.equal(calls.at(-1), expected);
  }
});

/** Minimal IntersectionObserver double: JSDOM ships none, so the component's
 *  sentinel path is otherwise unreachable in tests. */
function installIntersectionObserver() {
  const instances = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = [];
      this.disconnected = false;
      this.log = [];
      instances.push(this);
    }
    observe(target) { this.targets.push(target); }
    unobserve(target) { this.targets = this.targets.filter((entry) => entry !== target); }
    takeRecords() {
      this.log.push("takeRecords");
      return [];
    }
    disconnect() {
      this.log.push("disconnect");
      this.disconnected = true;
      this.targets = [];
    }
    /** Delivers a batch the way a queued notification would — including after
     *  the owner tore the observer down. */
    emit(isIntersecting = true, targets = this.targets) {
      this.callback(targets.map((target) => ({ target, isIntersecting })), this);
    }
  }
  window.IntersectionObserver = FakeIntersectionObserver;
  return {
    instances,
    live: () => instances.filter((observer) => !observer.disconnected),
    latest: () => instances[instances.length - 1],
  };
}

test("Recent paginates without any Show more control", async () => {
  installDom();
  await act(async () => root.render(renderSidebar()));
  assert.equal(recentRowCount(), INITIAL_ROWS,
    "the sidebar must not render the whole catalog up front");
  assert.equal(document.querySelector(".session-list-more"), null);
  assert.equal([...document.querySelectorAll(".recent-session-list button")]
    .some((button) => /show more/i.test(button.textContent || "")), false,
  "pagination is automatic: no Show more button may remain");
  const end = sentinel();
  assert.ok(end, "an invisible end sentinel drives the next page");
  assert.equal(end.getAttribute("aria-hidden"), "true");
  assert.equal(end.textContent, "");
});

test("the end sentinel reveals every remaining row and then drains and disconnects", async () => {
  installDom();
  const observers = installIntersectionObserver();
  await act(async () => root.render(renderSidebar()));
  assert.equal(observers.live().length, 1);
  assert.equal(observers.latest().options?.root, scrollerEl(),
    "the observer must be rooted at the sidebar scroller");
  assert.equal(observers.latest().options?.rootMargin, "240px 0px");
  assert.equal(observers.latest().targets[0], sentinel());

  const seen = [recentRowCount()];
  // A sentinel that stays visible must keep filling the viewport, so each page
  // re-arms the observer; the walk terminates when the sentinel unmounts.
  for (let page = 0; page < 10 && sentinel(); page += 1) {
    const observer = observers.latest();
    await act(async () => observer.emit(true));
    seen.push(recentRowCount());
  }
  assert.deepEqual(seen, [
    INITIAL_ROWS,
    INITIAL_ROWS + PAGE_ROWS,
    INITIAL_ROWS + PAGE_ROWS * 2,
    TOTAL_SESSIONS,
  ]);
  assert.equal(sentinel(), null, "the sentinel leaves once every row is visible");
  assert.equal(observers.live().length, 0, "every observer disconnects on cleanup");
  for (const observer of observers.instances) {
    assert.deepEqual(observer.log, ["takeRecords", "disconnect"],
      "pending records are drained before the observer is dropped");
  }
});

test("a non-intersecting or stale observer batch never pages", async () => {
  installDom();
  const observers = installIntersectionObserver();
  await act(async () => root.render(renderSidebar()));
  const first = observers.latest();
  await act(async () => first.emit(false));
  assert.equal(recentRowCount(), INITIAL_ROWS, "a sentinel out of view must not page");

  // Collapse tears the observer down; a batch queued before that still fires.
  await act(async () => recentToggle().click());
  assert.equal(observers.live().length, 0);
  await act(async () => first.emit(true, [document.createElement("div")]));
  await act(async () => recentToggle().click());
  assert.equal(recentRowCount(), INITIAL_ROWS,
    "a callback queued before teardown must be a no-op");

  // Same for a batch that lands after the surface goes inactive.
  const live = observers.latest();
  await act(async () => root.render(renderSidebar({ panelActive: true })));
  await act(async () => live.emit(true, [document.createElement("div")]));
  await act(async () => root.render(renderSidebar({ panelActive: false })));
  assert.equal(recentRowCount(), INITIAL_ROWS,
    "a callback that lands after a panel switch must be a no-op");
});

test("collapsing Recent, panel activation and closing tear the observer down", async () => {
  installDom();
  const observers = installIntersectionObserver();
  await act(async () => root.render(renderSidebar()));
  assert.equal(observers.live().length, 1);
  await act(async () => recentToggle().click());
  assert.equal(observers.live().length, 0, "a collapsed Recent section observes nothing");
  assert.equal(sentinel(), null);

  await act(async () => recentToggle().click());
  assert.equal(observers.live().length, 1);
  await act(async () => root.render(renderSidebar({ panelActive: true })));
  assert.equal(observers.live().length, 0, "an inactive Sessions surface observes nothing");
  await act(async () => root.render(renderSidebar({ panelActive: false })));
  assert.equal(observers.live().length, 1);
  await act(async () => root.render(renderSidebar({ open: false })));
  assert.equal(observers.live().length, 0, "a closed sidebar observes nothing");
});

test("scroll fallback pages by sentinel proximity, not by scroller bottom", async () => {
  installDom();
  delete window.IntersectionObserver;
  await act(async () => root.render(renderSidebar({ sessions: withArchivedTail() })));
  assert.equal(recentRowCount(), INITIAL_ROWS);
  assert.ok(document.querySelector(".sidebar-archived"), "Archived renders below Recent");

  // Sentinel far below the viewport: no paging, however the scroller reads.
  let scroller = placeSentinel(900);
  await fireScroll(scroller);
  assert.equal(recentRowCount(), INITIAL_ROWS, "a distant sentinel must not page");

  // Sentinel within the reveal margin while the scroller is nowhere near its
  // own bottom (Archived below): whole-scroller math would refuse to page.
  scroller = placeSentinel(40);
  await fireScroll(scroller);
  assert.equal(recentRowCount(), INITIAL_ROWS + PAGE_ROWS,
    "content below Recent must not block sentinel paging");

  for (let page = 0; page < 10 && sentinel(); page += 1) {
    scroller = placeSentinel(40);
    await fireScroll(scroller);
  }
  assert.equal(recentRowCount(), TOTAL_SESSIONS);
  assert.equal(sentinel(), null);
});

test("the scroll fallback ignores closed, panel-active and collapsed states", async () => {
  installDom();
  delete window.IntersectionObserver;
  const inactive = [{ open: false }, { panelActive: true }];
  for (const props of inactive) {
    await act(async () => root.render(renderSidebar()));
    placeSentinel(0);
    await act(async () => root.render(renderSidebar(props)));
    const scroller = scrollerEl();
    await fireScroll(scroller);
    assert.equal(recentRowCount(), INITIAL_ROWS,
      `${JSON.stringify(props)} must not page the Recent list`);
  }

  await act(async () => root.render(renderSidebar()));
  const scroller = placeSentinel(0);
  await act(async () => recentToggle().click());
  await fireScroll(scroller);
  await act(async () => recentToggle().click());
  assert.equal(recentRowCount(), INITIAL_ROWS, "a collapsed Recent list must not page");

  // The same scroll pages once the list is active again.
  await fireScroll(placeSentinel(0));
  assert.equal(recentRowCount(), INITIAL_ROWS + PAGE_ROWS);
});

test("a selected row beyond the first page stays rendered", async () => {
  installDom();
  await act(async () => root.render(renderSidebar({
    selection: { kind: "session", id: "session-100" },
  })));
  assert.equal(recentRowCount(), 101);
  assert.ok(document.querySelector('.recent-session-list .session-row[data-session-id="session-100"].selected'));
});

test("a new leading session preserves the first visible row while scrolled", async () => {
  installDom();
  const sessions = makeSessions(20);
  await act(async () => root.render(renderSidebar({ sessions })));
  const scroller = scrollerEl();
  const geometry = installRecentRowGeometry(scroller, 108);
  await fireScroll(scroller);
  assert.equal(geometry.rowTop("session-3"), 0);

  const newest = {
    ...sessions[0],
    id: "session-new",
    title: "Newest session",
    activityAt: sessions[0].activityAt + 1,
    updatedAt: sessions[0].updatedAt + 1,
  };
  await act(async () => root.render(renderSidebar({ sessions: [newest, ...sessions] })));

  assert.equal(geometry.scrollTop, 144,
    "one inserted row should be absorbed into scrollTop");
  assert.equal(geometry.rowTop("session-3"), 0,
    "the previous first visible session must stay at the same screen coordinate");
});

test("activity promotion preserves the first visible row while scrolled", async () => {
  installDom();
  const sessions = makeSessions(20);
  await act(async () => root.render(renderSidebar({ sessions })));
  const scroller = scrollerEl();
  const geometry = installRecentRowGeometry(scroller, 108);
  await fireScroll(scroller);
  assert.equal(geometry.rowTop("session-3"), 0);

  const promoted = sessions.map((session) => session.id === "session-10"
    ? {
      ...session,
      activityAt: sessions[0].activityAt + 1,
      updatedAt: sessions[0].updatedAt + 1,
    }
    : session);
  await act(async () => root.render(renderSidebar({ sessions: promoted })));

  assert.equal(geometry.scrollTop, 144,
    "a row promoted above the viewport should be absorbed into scrollTop");
  assert.equal(geometry.rowTop("session-3"), 0,
    "activity ordering must not move the row the reader was looking at");
});

test("a new leading session remains visible when the list is already at the top", async () => {
  installDom();
  const sessions = makeSessions(20);
  await act(async () => root.render(renderSidebar({ sessions })));
  const scroller = scrollerEl();
  const geometry = installRecentRowGeometry(scroller, 0);
  await fireScroll(scroller);
  const newest = {
    ...sessions[0],
    id: "session-new-at-top",
    title: "Newest at top",
    activityAt: sessions[0].activityAt + 1,
    updatedAt: sessions[0].updatedAt + 1,
  };

  await act(async () => root.render(renderSidebar({ sessions: [newest, ...sessions] })));

  assert.equal(geometry.scrollTop, 0);
  assert.equal(document.querySelector(".recent-session-list .session-row")
    ?.getAttribute("data-session-id"), newest.id);
});

test("session rows publish workspace drag frames without triggering their click action", async () => {
  installDom();
  const frames = [];
  const resumed = [];
  const unsubscribe = subscribeTabDrag((frame) => frames.push(frame));
  try {
    await act(async () => root.render(renderSidebar({
      onResumeSession: (sessionId) => resumed.push(sessionId),
    })));
    const row = document.querySelector('.session-row[data-session-id="session-0"]');
    const main = row.querySelector(".session-row-main");
    await act(async () => {
      main.dispatchEvent(new window.MouseEvent("pointerdown", {
        bubbles: true, button: 0, clientX: 20, clientY: 20,
      }));
      row.dispatchEvent(new window.MouseEvent("pointermove", {
        bubbles: true, button: 0, clientX: 28, clientY: 32,
      }));
    });
    assert.equal(row.getAttribute("aria-grabbed"), "true");
    assert.equal(document.querySelector(".session-row-drag-ghost")?.textContent, "Session 0");
    assert.deepEqual(frames.map(({ kind, phase, key }) => ({ kind, phase, key })), [{
      kind: "session", phase: "move", key: "session:session-0",
    }]);

    await act(async () => {
      row.dispatchEvent(new window.MouseEvent("pointerup", {
        bubbles: true, button: 0, clientX: 28, clientY: 32,
      }));
      main.click();
    });
    assert.equal(resumed.length, 0, "the synthetic post-drag click must be consumed");
    assert.equal(frames.at(-1).phase, "drop");
    assert.equal(document.querySelector(".session-row-drag-ghost"), null);
    assert.equal(document.body.dataset.tabDragging, undefined);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      main.click();
    });
    assert.deepEqual(resumed, ["session-0"], "ordinary clicks still resume after the drag");
  } finally {
    unsubscribe();
  }
});
