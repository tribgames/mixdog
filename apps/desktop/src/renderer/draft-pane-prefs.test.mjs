import assert from "node:assert/strict";
import test from "node:test";

import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.mixdogDesktop = { rendererDiagnostic() {} };

const { useDraftPanePreferences } = await import("./use-draft-pane-preferences.ts");

const PROJECT = "C:/Project/mixdog";

/** The catalog gate as the renderer applies it before validation: the
 *  requested path passes through untouched. */
const passThroughProjectPath = (candidate) => String(candidate || "").trim();

function Harness({ preferred, resolve, report }) {
  const selection = { kind: "new" };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  report(useDraftPanePreferences({
    selection,
    selectionRef,
    snapshot: {},
    projectCatalogValidated: Boolean(preferred),
    preferredDraftProjectPath: preferred,
    effectiveDraftProjectPath: resolve,
  }));
  return null;
}

/** Mounts the draft-prefs hook against a live DOM, exposing its API and the
 *  project the "default" draft currently resolves to. */
async function mountDrafts(preferred, resolve = passThroughProjectPath) {
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const latest = { api: null };
  const render = async (nextPreferred) => {
    await act(async () => {
      root.render(React.createElement(Harness, {
        preferred: nextPreferred,
        resolve,
        report: (api) => { latest.api = api; },
      }));
    });
  };
  await render(preferred);
  return {
    render,
    api: () => latest.api,
    project: () => latest.api.resolvedDraftPrefsFor("default").projectPath,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("a draft that never chose a project adopts a catalog that lands later", async (t) => {
  window.localStorage.clear();
  // The phone paints its first New task before the relay answers, so nothing
  // is known about projects yet.
  const drafts = await mountDrafts("");
  t.after(() => drafts.unmount());
  assert.equal(drafts.project(), "");

  await drafts.render(PROJECT);
  assert.equal(drafts.project(), PROJECT);
});

test("the empty first paint does not survive as a stored choice", async (t) => {
  window.localStorage.clear();
  const first = await mountDrafts("");
  assert.equal(first.project(), "");
  await first.unmount();

  // Reload with the catalog available: the draft must follow it instead of
  // replaying the empty value its first paint stored.
  const second = await mountDrafts(PROJECT);
  t.after(() => second.unmount());
  assert.equal(second.project(), PROJECT);
});

test("an explicit No project survives a reload", async (t) => {
  window.localStorage.clear();
  const first = await mountDrafts(PROJECT);
  await act(async () => first.api().stageNewTaskProject(""));
  assert.equal(first.project(), "");
  await first.unmount();

  const second = await mountDrafts(PROJECT);
  t.after(() => second.unmount());
  assert.equal(second.project(), "");
});

test("an explicit project choice survives a reload", async (t) => {
  window.localStorage.clear();
  const first = await mountDrafts(PROJECT);
  await act(async () => first.api().stageNewTaskProject("C:/Project/other"));
  await first.unmount();

  const second = await mountDrafts(PROJECT);
  t.after(() => second.unmount());
  assert.equal(second.project(), "C:/Project/other");
});

test("legacy entries release their empty project and keep real ones", async (t) => {
  window.localStorage.clear();
  window.localStorage.setItem(
    "mixdog.desktop-draft-pane-prefs.v2",
    JSON.stringify([["default", { projectPath: "", modelSelection: null, workflow: null }]]),
  );
  const frozen = await mountDrafts(PROJECT);
  assert.equal(frozen.project(), PROJECT);
  await frozen.unmount();

  window.localStorage.clear();
  window.localStorage.setItem(
    "mixdog.desktop-draft-pane-prefs.v2",
    JSON.stringify([["default", {
      projectPath: "C:/Project/other",
      modelSelection: null,
      workflow: null,
    }]]),
  );
  const kept = await mountDrafts(PROJECT);
  t.after(() => kept.unmount());
  assert.equal(kept.project(), "C:/Project/other");
});

test("a catalog that cannot place the stored project releases it, not clears it", async (t) => {
  window.localStorage.clear();
  const chosen = await mountDrafts(PROJECT);
  await act(async () => chosen.api().stageNewTaskProject(PROJECT));
  assert.equal(chosen.project(), PROJECT);
  await chosen.unmount();

  // A phone that reconnects onto an empty catalog: every lookup answers "".
  const blank = await mountDrafts(PROJECT, () => "");
  assert.equal(blank.project(), "");
  await blank.unmount();

  // The lost lookup must not have been stored as an explicit No project, so
  // the choice returns on its own once the catalog is whole again.
  const recovered = await mountDrafts(PROJECT);
  t.after(() => recovered.unmount());
  assert.equal(recovered.project(), PROJECT);
});
