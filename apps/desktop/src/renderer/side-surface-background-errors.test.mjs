import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(name, import.meta.url), "utf8");

test("side panel background reads do not escalate into red notifications", async () => {
  const [app, schedules, webhooks, workflows] = await Promise.all([
    source("./App.tsx"),
    source("./SchedulesView.tsx"),
    source("./WebhooksView.tsx"),
    source("./WorkflowsView.tsx"),
  ]);

  for (const panel of [schedules, webhooks, workflows]) {
    assert.doesNotMatch(panel, /showDesktopToast\(referenceError/);
    assert.doesNotMatch(panel, /dismissDesktopToast/);
  }
  assert.doesNotMatch(app, /void invoke\(refreshProjects\)/);
  assert.match(app, /refreshSessions\(\)\.catch\(\(\) => undefined\)/);
  assert.match(
    app,
    /refreshProjects\(\{[\s\S]*?acceptEmpty:\s*!isMobileRemoteSurface\(\),[\s\S]*?\}\)\.catch\(\(\) => \[\]\)/,
  );
});

test("right side background reads stay neutral while action failures remain alerts", async () => {
  const [sourceControl, pullRequests] = await Promise.all([
    source("./SourceControlDock.tsx"),
    source("./PullRequestsPane.tsx"),
  ]);

  assert.match(sourceControl, /if \(!status && statusError\)/);
  assert.match(sourceControl, /className="utility-dock-empty" role="status"/);
  assert.doesNotMatch(sourceControl, /\(error \|\| statusError\).*dock-scm-error/);
  assert.match(sourceControl, /\{error && <p className="dock-scm-error" role="alert"/);

  assert.match(pullRequests, /categories === null && readError/);
  assert.match(pullRequests, /className="dock-pr-empty" role="status"/);
  assert.match(pullRequests, /actionError && <div className="dock-pr-error-state" role="alert"/);
  assert.doesNotMatch(pullRequests, /\{listError &&/);
});
