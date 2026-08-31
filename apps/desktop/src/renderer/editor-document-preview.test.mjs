// Opening an Office document in the editor: which viewer a surface gets, and
// what happens when the conversion behind it is unavailable.
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

const { useEditorFileSession } = await import("./use-editor-file-session.ts");

async function mountSession(api, relPath) {
  window.mixdogDesktop = api;
  const session = { current: null };
  function Harness() {
    const editorRef = useRef(null);
    const syncLspRef = useRef(async () => false);
    session.current = useEditorFileSession({
      editorRef,
      projectPath: "C:/Project/demo",
      relPath,
      active: true,
      editorSettings: {},
      notifyReady() {},
      onDirty() {},
      syncLspRef,
    });
    return null;
  }
  const host = document.createElement("div");
  document.querySelector("main").append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  return { root, session };
}

const renderedPage = (page) => ({
  page,
  width: 1200,
  height: 1697,
  mime: "image/png",
  base64: `page-${page}`,
});

test("a surface without a PDF viewer opens the document as pages and scrolls on", async () => {
  const requested = [];
  const api = {
    previewDocumentPages: async (_projectPath, _relPath, _accessToken, options) => {
      requested.push([...options.pages]);
      return {
        format: "docx",
        mtimeMs: 42,
        size: 4096,
        pageCount: 3,
        pages: options.pages.map(renderedPage),
      };
    },
  };
  const { root, session } = await mountSession(api, "docs/report.docx");
  try {
    assert.deepEqual(requested, [[1]], "opening costs exactly one page");
    assert.equal(session.current.documentPreview.pageCount, 3);
    assert.equal(session.current.preview, null, "no PDF viewer is claimed here");
    assert.equal(session.current.load.binary, true, "the text editor stays out of the way");

    // Pages arriving out of order still read top to bottom.
    await act(async () => session.current.loadDocumentPages([3, 2]));
    assert.deepEqual(
      session.current.documentPreview.pages.map((page) => page.page),
      [1, 2, 3],
    );
    assert.equal(session.current.documentError, "");
  } finally {
    await act(async () => root.unmount());
  }
});

test("Electron shows the same document through its own PDF viewer", async () => {
  const api = {
    previewDocumentFile: async () => ({
      url: "mixdog-media://preview/token/report.docx",
      kind: "pdf",
      mime: "application/pdf",
      format: "docx",
      mtimeMs: 7,
      size: 2048,
    }),
    previewDocumentPages: async () => {
      throw new Error("a local surface must not pay for rasterized pages");
    },
    readProjectFile: async () => {
      throw new Error("a converted document must not be read as text");
    },
  };
  const { root, session } = await mountSession(api, "docs/deck.pptx");
  try {
    assert.equal(session.current.preview.kind, "pdf");
    assert.equal(session.current.preview.url, "mixdog-media://preview/token/report.docx");
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a document that cannot be converted keeps the open-in-default-app escape", async () => {
  const api = {
    previewDocumentFile: async () => {
      throw new Error("LibreOffice is not installed");
    },
    readProjectFile: async () => ({
      content: "",
      mtimeMs: 11,
      binary: true,
      tooLarge: false,
      encoding: "utf8",
    }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, "docs/budget.xlsx");
  try {
    assert.match(session.current.documentError, /LibreOffice/);
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true, "the binary notice is what stays on screen");
    assert.equal(session.current.error, "", "a missing viewer is not a load failure");
  } finally {
    await act(async () => root.unmount());
  }
});
