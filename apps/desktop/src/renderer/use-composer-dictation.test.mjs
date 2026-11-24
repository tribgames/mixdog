import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useComposerDictation } from './use-composer-dictation.ts';
import { SurfaceActiveContext } from './surface-activity.ts';
import { stashedComposerDraft } from './composer-draft.ts';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeTrack(muted) {
  const listeners = new Set();
  return {
    muted,
    stopped: 0,
    stop() {
      this.stopped += 1;
    },
    addEventListener(type, listener) {
      if (type === 'unmute') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'unmute') listeners.delete(listener);
    },
    unmute() {
      this.muted = false;
      for (const listener of [...listeners]) listener();
    },
  };
}

async function withDictation({ muted = false } = {}, run) {
  const dom = new JSDOM("<div id='root'></div><button>Send</button><textarea></textarea>", {
    url: 'https://voice.example',
  });
  const originals = new Map();
  const expose = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const track = fakeTrack(muted);
  let resolveTranscript;
  const ctx = {
    dom,
    hook: null,
    draft: '',
    submissions: 0,
    probes: 0,
    micRequests: 0,
    recorders: [],
    calls: [],
    notices: [],
    uploaded: undefined,
    failStart: false,
    transcriptGate: Promise.resolve(),
    holdTranscript() {
      this.transcriptGate = new Promise((resolve) => {
        this.releaseTranscript = resolve;
      });
    },
    track,
    stream: { getTracks: () => [track], getAudioTracks: () => [track] },
    resolveMic: null,
    transcriptReady: new Promise((resolve) => {
      resolveTranscript = resolve;
    }),
    get recorder() {
      return this.recorders.at(-1);
    },
    called(capability) {
      return this.calls.filter((name) => name === capability).length;
    },
    // Starting the toggle and resolving the mic are separate steps, so the
    // state between them (preparing) is observable.
    async openMic() {
      let starting;
      await act(async () => {
        starting = this.hook.toggleDictation();
      });
      await act(async () => {
        this.resolveMic(this.stream);
        await starting;
      });
    },
    async fireStart() {
      await act(async () => {
        this.recorder.onstart();
        await tick();
      });
    },
  };
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    mimeType = 'audio/webm;codecs=opus';
    state = 'inactive';
    constructor() {
      ctx.recorders.push(this);
    }
    start() {
      if (ctx.failStart) throw new DOMException('The stream cannot be recorded.', 'NotSupportedError');
      this.state = 'recording';
      this.ondataavailable({ data: new dom.window.Blob(['first words']) });
    }
    stop() {
      if (this.state === 'inactive') throw new Error('The recorder already stopped.');
      this.state = 'inactive';
      this.onstop();
    }
  }
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('navigator', {
    mediaDevices: {
      getUserMedia: () => {
        ctx.micRequests += 1;
        return new Promise((resolve) => {
          ctx.resolveMic = resolve;
        });
      },
      enumerateDevices: () => {
        throw new Error('Device enumeration must not delay capture');
      },
    },
  });
  expose('MediaRecorder', Recorder);
  expose('Blob', dom.window.Blob);
  expose('FileReader', dom.window.FileReader);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.mixdogDesktop = {
    invokeCapability: async ({ capability, args }) => {
      ctx.calls.push(capability);
      if (capability === 'getVoiceStatus') {
        ctx.probes += 1;
        if (ctx.probes > 1) return new Promise(() => {});
        return { value: { installed: true, enabled: true } };
      }
      if (capability === 'prepareTranscription') {
        assert.deepEqual(args, []);
        // A daemon without the capability: warming must fail silently.
        throw new Error('Unknown capability: prepareTranscription');
      }
      assert.equal(capability, 'transcribeAudio');
      ctx.uploaded = args[0];
      await ctx.transcriptGate;
      if (ctx.failTranscript) throw new Error('transcription failed');
      return { value: 'first words' };
    },
  };
  // The conversation's place: shown or not (SurfaceActiveContext, set by the
  // pane workspace), and the focused pane's or not (keysActive).
  ctx.surfaceActive = true;
  ctx.keysActive = true;
  function Harness() {
    ctx.hook = useComposerDictation({
      keysActive: ctx.keysActive,
      identityScope: 'session-a',
      transitioningRef: { current: false },
      textarea: { current: dom.window.document.querySelector('textarea') },
      setDraft: (update) => {
        ctx.draft = update(ctx.draft);
        resolveTranscript();
      },
      invokeResult: async (action) => {
        try {
          return await action();
        } catch (reason) {
          ctx.invokeError?.(String(reason));
          return undefined;
        }
      },
      showNotice: (message) => ctx.notices.push(message),
      requestVoiceInstall: () => assert.fail('Already installed'),
      onTranscriptSubmit: (text, take) => {
        ctx.submissions += 1;
        ctx.submitted = text;
        take.settle(true);
        resolveTranscript();
      },
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const tree = () =>
    React.createElement(SurfaceActiveContext.Provider, { value: ctx.surfaceActive }, React.createElement(Harness));
  ctx.place = async (patch) => {
    Object.assign(ctx, patch);
    await act(async () => {
      root.render(tree());
      await tick();
    });
  };
  // Enter as the user presses it in another composer: did a listener take it?
  ctx.pressKey = async (key) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
    await act(async () => {
      dom.window.dispatchEvent(event);
      await tick();
    });
    return event.defaultPrevented;
  };
  try {
    await act(async () => {
      root.render(tree());
    });
    assert.equal(ctx.hook.dictationAvailable, true);
    await run(ctx);
  } finally {
    // A closed composer's take finishes out of sight; one left running here would outlive this test's DOM.
    await act(async () => {
      ctx.hook.cancelDictation();
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

for (const submitOnStop of [false, true]) {
  test(`dictation opens the mic immediately, records once capture starts, and ${submitOnStop ? 'sends without moving focus' : 'focuses the transcript for editing'}`, async () => {
    await withDictation({}, async (ctx) => {
      let starting;
      await act(async () => {
        starting = ctx.hook.toggleDictation();
        assert.equal(ctx.micRequests, 1, 'mic request happens before yielding to any server response');
        await ctx.hook.toggleDictation();
        assert.equal(ctx.micRequests, 1, 'double clicks do not open a second mic');
      });
      assert.equal(ctx.hook.dictationState, 'preparing', 'the tap shows preparing while the mic opens');
      await act(async () => {
        ctx.resolveMic(ctx.stream);
        await starting;
      });
      assert.equal(ctx.recorder.state, 'recording');
      assert.equal(ctx.hook.dictationState, 'preparing', 'not recording until the recorder reports start');
      assert.equal(ctx.hook.recordingElapsedMs, 0);
      assert.equal(ctx.called('prepareTranscription'), 0);
      await ctx.fireStart();
      assert.equal(ctx.hook.dictationState, 'recording');
      assert.equal(ctx.called('prepareTranscription'), 1, 'the server warms while the user speaks');
      assert.equal(ctx.probes, 1);
      const sendButton = ctx.dom.window.document.querySelector('button');
      sendButton.focus();
      await act(async () => {
        if (submitOnStop) ctx.hook.stopDictationAndSend();
        else await ctx.hook.toggleDictation();
        await ctx.transcriptReady;
        // Flush the deferred focus callback after the transcript has landed.
        await new Promise((resolve) => ctx.dom.window.setTimeout(resolve, 0));
      });
      assert.equal(Buffer.from(ctx.uploaded.data, 'base64').toString(), 'first words');
      // A sent take's words go to the send, never through the draft.
      assert.equal(ctx.draft, submitOnStop ? '' : 'first words');
      assert.equal(ctx.submitted, submitOnStop ? 'first words' : undefined);
      assert.equal(ctx.hook.dictationState, 'idle');
      assert.equal(ctx.track.stopped, 1);
      assert.equal(ctx.submissions, submitOnStop ? 1 : 0);
      assert.equal(
        ctx.dom.window.document.activeElement,
        submitOnStop ? sendButton : ctx.dom.window.document.querySelector('textarea')
      );
      assert.deepEqual(ctx.notices, [], 'a failed warm-up is never surfaced');
    });
  });
}

test('a muted mic track stays preparing until it unmutes', async () => {
  await withDictation({ muted: true }, async (ctx) => {
    await ctx.openMic();
    await ctx.fireStart();
    assert.equal(ctx.hook.dictationState, 'preparing');
    assert.equal(ctx.called('prepareTranscription'), 0);
    await act(async () => {
      ctx.track.unmute();
      await tick();
    });
    assert.equal(ctx.hook.dictationState, 'recording');
    assert.equal(ctx.called('prepareTranscription'), 1);
  });
});

test('a mic track that never unmutes records after a bounded wait', async () => {
  await withDictation({ muted: true }, async (ctx) => {
    await ctx.openMic();
    await ctx.fireStart();
    assert.equal(ctx.hook.dictationState, 'preparing');
    await act(async () => {
      await tick(1_600);
    });
    assert.equal(ctx.hook.dictationState, 'recording');
  });
});

test('Esc while preparing discards the take and releases the mic', async () => {
  await withDictation({ muted: true }, async (ctx) => {
    await ctx.openMic();
    await act(async () => {
      ctx.dom.window.dispatchEvent(new ctx.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
      await tick();
    });
    assert.equal(ctx.hook.dictationState, 'idle');
    assert.equal(ctx.recorder.state, 'inactive');
    assert.equal(ctx.track.stopped, 1);
    // A late start event must not revive the discarded take.
    await ctx.fireStart();
    await act(async () => {
      ctx.track.unmute();
      await tick();
    });
    assert.equal(ctx.hook.dictationState, 'idle');
    assert.equal(ctx.called('transcribeAudio'), 0);
    assert.equal(ctx.called('prepareTranscription'), 0);
    assert.equal(ctx.draft, '');
  });
});

test('tapping the mic while preparing stops without transcribing', async () => {
  await withDictation({}, async (ctx) => {
    await ctx.openMic();
    await act(async () => {
      await ctx.hook.toggleDictation();
      await tick();
    });
    assert.equal(ctx.hook.dictationState, 'idle');
    assert.equal(ctx.track.stopped, 1);
    assert.equal(ctx.called('transcribeAudio'), 0);
    assert.deepEqual(ctx.notices, []);
  });
});

// Review P1: dictating in session A, switching to B and pressing Enter there
// stopped A's take (a window capture listener) and A's mic stayed live.
test('a conversation leaving the screen releases its mic and takes no key', async () => {
  await withDictation({}, async (ctx) => {
    await ctx.openMic();
    await ctx.fireStart();
    assert.equal(ctx.hook.dictationState, 'recording');
    // Switched away: the conversation is retained, off screen.
    await ctx.place({ surfaceActive: false, keysActive: false });
    // Bounded: a mic that is never released must fail here, not hang.
    await act(async () => {
      await Promise.race([ctx.transcriptReady, tick(500)]);
      await tick();
    });
    assert.equal(ctx.recorder.state, 'inactive', 'the recorder stopped');
    assert.equal(ctx.track.stopped, 1, 'the mic is released');
    assert.equal(ctx.hook.dictationState, 'idle');
    assert.equal(ctx.draft, 'first words', 'what was said waits in its own draft');
    assert.equal(ctx.submissions, 0, 'nothing is sent from the hidden conversation');
    assert.notEqual(
      ctx.dom.window.document.activeElement,
      ctx.dom.window.document.querySelector('textarea'),
      'a hidden composer takes no focus'
    );
    // Enter and Esc pressed in the shown conversation reach it untouched.
    assert.equal(await ctx.pressKey('Enter'), false);
    assert.equal(await ctx.pressKey('Escape'), false);
    assert.equal(ctx.called('transcribeAudio'), 1);
  });
});

test('a take still opening the mic when its conversation hides is discarded with the stream', async () => {
  await withDictation({}, async (ctx) => {
    let starting;
    await act(async () => {
      starting = ctx.hook.toggleDictation();
    });
    assert.equal(ctx.hook.dictationState, 'preparing');
    await ctx.place({ surfaceActive: false });
    assert.equal(ctx.hook.dictationState, 'idle');
    await act(async () => {
      ctx.resolveMic(ctx.stream);
      await starting;
    });
    assert.equal(ctx.track.stopped, 1, 'the late stream is released at once');
    assert.equal(ctx.recorders.length, 0, 'no recorder starts off screen');
  });
});

test('turning voice off discards a live take and prevents a new mic request', async () => {
  await withDictation({}, async (ctx) => {
    await ctx.openMic();
    await ctx.fireStart();
    await act(async () => {
      ctx.dom.window.dispatchEvent(
        new ctx.dom.window.CustomEvent('mixdog:voice-runtime-changed', {
          detail: { installed: true, enabled: false },
        })
      );
    });
    assert.equal(ctx.recorder.state, 'inactive');
    assert.ok(ctx.track.stopped > 0);
    assert.equal(ctx.called('transcribeAudio'), 0);
    assert.equal(ctx.hook.dictationAvailable, false);
    await act(async () => ctx.hook.toggleDictation());
    assert.equal(ctx.micRequests, 1);
  });
});

test('a take in a pane that is not focused leaves Enter and Esc to the focused pane', async () => {
  await withDictation({}, async (ctx) => {
    await ctx.openMic();
    await ctx.fireStart();
    // Still on screen (split view), but the user typed into the other pane.
    await ctx.place({ keysActive: false });
    assert.equal(await ctx.pressKey('Enter'), false, 'Enter is not swallowed');
    assert.equal(await ctx.pressKey('Escape'), false, 'Esc is not swallowed');
    assert.equal(ctx.hook.dictationState, 'recording', 'the visible take keeps recording');
    assert.equal(ctx.track.stopped, 0);
    // Focus comes back to its pane: Enter finishes the take again.
    await ctx.place({ keysActive: true });
    assert.equal(await ctx.pressKey('Enter'), true);
    await act(async () => {
      await ctx.transcriptReady;
    });
    assert.equal(ctx.draft, 'first words');
  });
});

test('cancelling before the mic opens releases the stream when it arrives', async () => {
  await withDictation({}, async (ctx) => {
    let starting;
    await act(async () => {
      starting = ctx.hook.toggleDictation();
    });
    assert.equal(ctx.hook.dictationState, 'preparing');
    await act(async () => {
      ctx.hook.cancelDictation();
    });
    assert.equal(ctx.hook.dictationState, 'idle');
    await act(async () => {
      ctx.resolveMic(ctx.stream);
      await starting;
    });
    assert.equal(ctx.track.stopped, 1);
    assert.equal(ctx.recorders.length, 0);
    assert.equal(ctx.hook.dictationState, 'idle');
    assert.deepEqual(ctx.notices, []);
  });
});

test('a recorder that fails to start releases the mic, and the next tap starts a new take', async () => {
  await withDictation({}, async (ctx) => {
    ctx.failStart = true;
    await ctx.openMic();
    assert.equal(ctx.track.stopped, 1, 'the mic is released');
    assert.equal(ctx.hook.dictationState, 'idle');
    assert.equal(ctx.notices.length, 1, 'the failure is said');
    ctx.failStart = false;
    await ctx.openMic();
    assert.equal(ctx.micRequests, 2, 'the next tap opens the mic again');
    assert.equal(ctx.recorder.state, 'recording');
  });
});

test('words of a take whose conversation the composer left wait in that draft and are never sent', async () => {
  await withDictation({}, async (ctx) => {
    await ctx.openMic();
    await ctx.fireStart();
    ctx.holdTranscript();
    await act(async () => ctx.hook.stopDictationAndSend());
    // The composer shows session B while A's words are transcribed.
    await act(async () => ctx.hook.moveTo('session-b', false));
    await act(async () => {
      ctx.releaseTranscript();
      await tick();
    });
    assert.equal(ctx.draft, '', "B's draft is not written");
    assert.equal(ctx.submissions, 0, 'nothing is sent');
    assert.equal(stashedComposerDraft('session-a'), 'first words', 'A gets its words back when shown again');

    // A take in B, whose draft then becomes session C: the same conversation keeps recording and gets its words.
    await ctx.openMic();
    await ctx.fireStart();
    await act(async () => ctx.hook.moveTo('session-c', true));
    assert.equal(ctx.recorder.state, 'recording');
    await act(async () => {
      await ctx.hook.toggleDictation();
      await ctx.transcriptReady;
    });
    assert.equal(ctx.draft, 'first words');
    assert.equal(stashedComposerDraft('session-b'), '');
  });
});

// A transcription the daemon never answers left the state at transcribing for good: Send stayed disabled and
// nothing local could end it.
test('cancelling a transcription the daemon never answers frees the composer and drops the late words', async () => {
  await withDictation({}, async (ctx) => {
    await ctx.openMic();
    await ctx.fireStart();
    ctx.holdTranscript();
    await act(async () => {
      await ctx.hook.toggleDictation();
      await tick();
    });
    assert.equal(ctx.hook.dictationState, 'transcribing');
    assert.equal(await ctx.pressKey('Escape'), true, 'Esc is taken by the pending transcription');
    assert.equal(ctx.hook.dictationState, 'idle');
    await act(async () => {
      ctx.releaseTranscript();
      await tick();
    });
    assert.equal(ctx.hook.dictationState, 'idle');
    assert.equal(ctx.draft, '', 'the cancelled take does not write its words');
    assert.equal(ctx.submissions, 0);
  });
});

test('a cancelled take whose transcription later fails raises no error', async () => {
  await withDictation({}, async (ctx) => {
    const errors = [];
    ctx.invokeError = (message) => errors.push(message);
    await ctx.openMic();
    await ctx.fireStart();
    ctx.holdTranscript();
    ctx.failTranscript = true;
    await act(async () => {
      await ctx.hook.toggleDictation();
      await tick();
    });
    await act(async () => ctx.hook.cancelDictation());
    await act(async () => {
      ctx.releaseTranscript();
      await tick();
    });
    assert.deepEqual(errors, []);
    assert.equal(ctx.hook.dictationState, 'idle');
  });
});
