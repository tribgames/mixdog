import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { attachmentFromFile } from "./composer-attachments.ts";

function installBrowserImageHarness({ supportsWebp = true } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://mixdog.example/",
  });
  const keys = ["window", "document", "navigator", "FileReader", "Image", "URL"];
  const previous = new Map(keys.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]));
  const drawCalls = [];
  let capabilityCalls = 0;
  const originalCreateElement = dom.window.document.createElement.bind(dom.window.document);

  class TestImage {
    naturalWidth = 4_000;
    naturalHeight = 1_000;

    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  }

  Object.defineProperty(dom.window, "mixdogDesktop", {
    configurable: true,
    value: {
      invokeCapability() {
        capabilityCalls += 1;
        throw new Error("browser attachments must not use resizeImage RPC");
      },
    },
  });
  dom.window.document.createElement = (tagName, options) => {
    if (String(tagName).toLowerCase() !== "canvas") {
      return originalCreateElement(tagName, options);
    }
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_image, x, y, width, height) => {
          drawCalls.push({ x, y, width, height });
        },
      }),
      toBlob(callback, mimeType) {
        // A browser without WebP encoding hands back another type instead.
        const type = mimeType === "image/webp" && !supportsWebp ? "image/png" : mimeType;
        callback(new dom.window.Blob(["resized"], { type }));
      },
    };
  };

  const objectUrl = {
    createObjectURL: () => "blob:test-image",
    revokeObjectURL: () => {},
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    FileReader: { configurable: true, value: dom.window.FileReader },
    Image: { configurable: true, value: TestImage },
    URL: { configurable: true, value: objectUrl },
  });

  return {
    dom,
    drawCalls,
    capabilityCalls: () => capabilityCalls,
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("web image attachments resize locally before appearing in the draft", async () => {
  const harness = installBrowserImageHarness();
  try {
    const file = new harness.dom.window.File(["original"], "mobile.png", {
      type: "image/png",
    });
    const attachment = await attachmentFromFile(file, { id: 7 });

    assert.deepEqual(harness.drawCalls, [
      { x: 0, y: 0, width: 2_000, height: 500 },
    ]);
    assert.equal(harness.capabilityCalls(), 0);
    // Re-encoded as WebP: a lossless PNG screenshot is the largest thing a
    // phone can attach, and WebP keeps alpha at a fraction of the bytes.
    assert.equal(attachment?.mimeType, "image/webp");
    assert.equal(attachment?.data, "cmVzaXplZA==");
    assert.equal(
      attachment?.metadataText,
      "[Image: source: mobile.png, 4000x1000, displayed at 2000x500. "
        + "Multiply coordinates by 2.00 to map to the original image.]",
    );
  } finally {
    harness.close();
  }
});

test("a browser without WebP encoding still attaches a usable image", async () => {
  const harness = installBrowserImageHarness({ supportsWebp: false });
  try {
    const file = new harness.dom.window.File(["original"], "mobile.png", {
      type: "image/png",
    });
    const attachment = await attachmentFromFile(file, { id: 7 });
    assert.equal(attachment?.mimeType, "image/png");
    assert.equal(attachment?.data, "cmVzaXplZA==");
  } finally {
    harness.close();
  }
});
