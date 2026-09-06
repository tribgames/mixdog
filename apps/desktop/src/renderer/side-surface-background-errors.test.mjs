import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerHooks } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,", shortCircuit: true };
    return next(specifier, context);
  },
});
const { SourceControlDock } = await import("./SourceControlDock.tsx");

const source = (name) => readFile(new URL(name, import.meta.url), "utf8");

test("side panel background reads do not escalate into red notifications", async () => {
  const [app, projectCatalog, schedules, webhooks, workflows] = await Promise.all([
    source("./App.tsx"),
    source("./use-app-project-catalog.ts"),
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
    projectCatalog,
    /refreshProjects\(\{[\s\S]*?acceptEmpty:\s*!isMobileRemoteSurface\(\),[\s\S]*?\}\)\.catch\(\(\) => \[\]\)/,
  );
});

test("an unavailable background Git read renders a neutral state without the raw error", () => {
  const dom = new JSDOM("", { url: "http://localhost/" });
  const previous = globalThis.window;
  globalThis.window = dom.window;
  try {
    const markup = renderToStaticMarkup(React.createElement(SourceControlDock, {
      projectPath: "C:/project", status: null, statusReady: true, loading: false,
      statusError: "raw IPC failure", onRefreshStatus() {}, active: false,
      readinessKey: "test", onReadyChange() {},
    }));
    assert.match(markup, /role="status"/);
    assert.doesNotMatch(markup, /role="alert"|raw IPC failure/);
  } finally {
    globalThis.window = previous;
    dom.window.close();
  }
});
