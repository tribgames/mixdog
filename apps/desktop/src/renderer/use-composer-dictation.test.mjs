import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useComposerDictation } from "./use-composer-dictation.ts";

for (const submitOnStop of [false, true]) {
test(`dictation starts immediately and ${submitOnStop ? "sends without moving focus" : "focuses the transcript for editing"}`, async () => {
  const dom = new JSDOM("<div id='root'></div><button>Send</button><textarea></textarea>", { url: "https://voice.example" });
  const originals = new Map();
  const expose = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let hook;
  let draft = "";
  let submissions = 0;
  let probes = 0;
  let micRequests = 0;
  let stoppedTracks = 0;
  let recorder;
  let resolveMic;
  let uploaded;
  let resolveTranscript;
  const transcriptReady = new Promise((resolve) => { resolveTranscript = resolve; });
  const notices = [];
  const stream = { getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] };
  class Recorder {
    static isTypeSupported() { return true; }
    mimeType = "audio/webm;codecs=opus";
    state = "inactive";
    constructor() { recorder = this; }
    start() {
      this.state = "recording";
      this.ondataavailable({ data: new dom.window.Blob(["first words"]) });
    }
    stop() {
      this.state = "inactive";
      this.onstop();
    }
  }
  expose("window", dom.window);
  expose("document", dom.window.document);
  expose("navigator", {
    mediaDevices: {
      getUserMedia: () => {
        micRequests += 1;
        return new Promise((resolve) => { resolveMic = resolve; });
      },
      enumerateDevices: () => { throw new Error("Device enumeration must not delay capture"); },
    },
  });
  expose("MediaRecorder", Recorder);
  expose("Blob", dom.window.Blob);
  expose("FileReader", dom.window.FileReader);
  expose("IS_REACT_ACT_ENVIRONMENT", true);
  dom.window.mixdogDesktop = {
    invokeCapability: async ({ capability, args }) => {
      if (capability === "getVoiceStatus") {
        probes += 1;
        if (probes > 1) return new Promise(() => {});
        return { value: { installed: true } };
      }
      assert.equal(capability, "transcribeAudio");
      uploaded = args[0];
      return { value: "first words" };
    },
  };
  function Harness() {
    hook = useComposerDictation({
      transitioningRef: { current: false },
      textarea: { current: dom.window.document.querySelector("textarea") },
      setDraft: (update) => { draft = update(draft); resolveTranscript(); },
      invokeResult: (action) => action(),
      showNotice: (message) => notices.push(message),
      requestVoiceInstall: () => assert.fail("Already installed"),
      onTranscriptSubmit: () => { submissions += 1; },
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    await act(async () => { root.render(React.createElement(Harness)); });
    assert.equal(hook.dictationInstalled, true);
    await act(async () => {
      const starting = hook.toggleDictation();
      assert.equal(micRequests, 1, "mic request happens before yielding to any server response");
      await hook.toggleDictation();
      assert.equal(micRequests, 1, "double clicks do not open a second mic");
      resolveMic(stream);
      await starting;
    });
    assert.equal(recorder.state, "recording");
    assert.equal(hook.dictationState, "recording");
    assert.equal(probes, 1);
    const sendButton = dom.window.document.querySelector("button");
    sendButton.focus();
    await act(async () => {
      if (submitOnStop) hook.stopDictationAndSend();
      else await hook.toggleDictation();
      await transcriptReady;
      // Flush the deferred focus callback after the transcript has landed.
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    assert.equal(Buffer.from(uploaded.data, "base64").toString(), "first words");
    assert.equal(draft, "first words");
    assert.equal(hook.dictationState, "idle");
    assert.equal(stoppedTracks, 1);
    assert.equal(submissions, submitOnStop ? 1 : 0);
    assert.equal(dom.window.document.activeElement,
      submitOnStop ? sendButton : dom.window.document.querySelector("textarea"));
    assert.deepEqual(notices, []);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
}
