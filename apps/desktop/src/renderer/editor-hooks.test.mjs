import assert from "node:assert/strict";
import test from "node:test";

import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", {
  url: "https://mixdog.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 1;
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useEditorMountSession } = await import("./use-editor-mount-session.ts");

test("editor mount hook wires commands and model binding before publishing ready", async () => {
  const events = [];
  let onMount;
  const model = {
    getValue: () => "edited",
  };
  const editor = {
    getDomNode: () => null,
    getModel: () => model,
    restoreViewState() {},
    focus: () => events.push("focus"),
  };
  function Harness() {
    const editorRef = useRef(null);
    const editorLayoutObserver = useRef(null);
    const editorLayoutSize = useRef(null);
    const activeRef = useRef(false);
    const focusedRef = useRef(false);
    const savedText = useRef("saved");
    onMount = useEditorMountSession({
      editorRef,
      editorLayoutObserver,
      editorLayoutSize,
      scheduleEditorLayout() {},
      armFonts() {},
      bindModel: (_editor, boundModel) => {
        assert.equal(boundModel, model);
        events.push("bind");
      },
      wireCommands: () => events.push("commands"),
      activeRef,
      focusedRef,
      savedText,
      projectPath: "C:/Project/demo",
      relPath: "src/App.tsx",
      viewStateKey: "C:/Project/demo/src/App.tsx",
      readViewState: () => null,
      markDirty: (dirty) => events.push(`dirty:${dirty}`),
      renderAnsiOutput: (boundModel) => {
        assert.equal(boundModel, model);
        events.push("ansi");
      },
      notifyReady: () => events.push("ready"),
    });
    return null;
  }
  const root = createRoot(document.querySelector("main"));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => onMount(editor));
    assert.deepEqual(events, [
      "commands",
      "bind",
      "dirty:true",
      "ansi",
      "ready",
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
