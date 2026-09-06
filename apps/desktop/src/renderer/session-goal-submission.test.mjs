import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { GoalSubmissionContext, useGoalAfterSubmission } from "./session-goal-submission.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://mixdog.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("goal masks restore rejected submissions and admit real goal updates and session navigation", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const oldGoal = { id: "old", status: "complete", title: "Previous work", tasks: [] };
  function Goal({ goal, session }) {
    const visible = useGoalAfterSubmission(goal, session);
    return visible ? React.createElement("p", null, visible.title) : null;
  }
  const render = (submission, goal = oldGoal, session = "one") => act(async () => {
    root.render(React.createElement(GoalSubmissionContext.Provider, { value: submission },
      React.createElement(Goal, { goal, session })));
  });
  try {
    await render("");
    await render("rejected");
    await render("");
    assert.equal(host.textContent, "Previous work", "rejection restores the previous goal");

    await render("accepted");
    await render("accepted", { ...oldGoal, snapshotAt: 100, timeUsedMs: 100 });
    assert.equal(host.textContent, "", "clock-only snapshots cannot resurrect old chrome");
    await render("accepted", { ...oldGoal, status: "active", title: "Resumed work" });
    assert.equal(host.textContent, "Resumed work", "the same goal can explicitly resume");

    await render("second");
    await render("second", { id: "new", status: "active", title: "New work" });
    assert.equal(host.textContent, "New work", "a new goal is never masked by an old submission");

    await render("third");
    await render("", oldGoal, "two");
    assert.equal(host.textContent, "Previous work", "navigation does not inherit another session's mask");

    await render("", null);
    await render("empty", null);
    await render("empty", oldGoal);
    assert.equal(host.textContent, "Previous work", "a goal first published after submit is visible");

    for (const status of ["active", "paused", "blocked", "usage_limited", "duration_reached"]) {
      const continuing = { ...oldGoal, status, title: `Continuing ${status}` };
      await render("", continuing);
      await render(`continue-${status}`, continuing);
      assert.equal(host.textContent, continuing.title, `${status} work survives the next prompt`);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
