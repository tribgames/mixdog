import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { stashComposerDraft, stashedComposerDraft } from './composer-draft';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { subscribeSetupChanges } from './setup-change-refresh';
import { useSurfaceActive } from './surface-activity';

// `preparing` runs from the tap until audio is actually captured: a phone
// takes a noticeable moment to open the mic, and words spoken before capture
// starts are never recorded, so the UI must not claim "recording" early.
export type DictationState = 'idle' | 'preparing' | 'recording' | 'transcribing';

// Mobile browsers hand out a mic track that stays `muted` until audio flows.
// Bounded, so a track that never reports `unmute` still records.
const UNMUTE_WAIT_MS = 1_500;

type DictationMeter = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  frame: number;
};
type VoiceStatus = { installed?: boolean; enabled?: boolean };

// The recording overlay paints its bars from a ref, never from React state: a
// per-frame level in state would re-render the whole composer (model pickers
// included) for as long as the user keeps speaking.
function startLevelMeter(stream: MediaStream, level: { current: number }): DictationMeter | null {
  const Context =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  try {
    const context = new Context();
    void Promise.resolve(context.resume()).catch(() => {
      // Autoplay policy may hold the graph suspended; the bars stay flat.
    });
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const meter: DictationMeter = { context, source, analyser, frame: 0 };
    const sample = (): void => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
      // Speech RMS sits near 0.05–0.2, so the gain lifts it into the bar range.
      // The ease attacks fast and releases slowly: a symmetric filter reads as
      // per-frame flicker instead of a voice.
      const loudness = Math.min(1, Math.sqrt(sum / samples.length) * 7);
      level.current += (loudness - level.current) * (loudness > level.current ? 0.5 : 0.15);
      meter.frame = window.requestAnimationFrame(sample);
    };
    meter.frame = window.requestAnimationFrame(sample);
    return meter;
  } catch {
    // Metering is decoration: recording itself must still work without it.
    return null;
  }
}

function stopLevelMeter(meter: DictationMeter | null, level: { current: number }): void {
  level.current = 0;
  if (!meter) return;
  window.cancelAnimationFrame(meter.frame);
  try {
    meter.source.disconnect();
  } catch {
    /* already disconnected */
  }
  try {
    meter.analyser.disconnect();
  } catch {
    /* already disconnected */
  }
  void Promise.resolve(meter.context.close()).catch(() => {
    // Closing the graph is best-effort during teardown.
  });
}

/** Stopping a recorder that has already stopped throws; every stop path here
 *  treats that as the state it asked for. */
function stopRecorder(recorder: MediaRecorder): void {
  try {
    recorder.stop();
  } catch {
    // The recorder already stopped.
  }
}

function whenTrackLive(stream: MediaStream): Promise<void> {
  const track = stream.getAudioTracks()[0];
  if (!track?.muted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer);
      track.removeEventListener('unmute', done);
      resolve();
    };
    const timer = window.setTimeout(done, UNMUTE_WAIT_MS);
    track.addEventListener('unmute', done);
  });
}

// Starts the transcription server while the user is still speaking, so the
// upload does not also pay its cold start. Purely an optimisation: an older
// daemon or a failed warm-up leaves transcribeAudio to start it as before.
function warmTranscription(): void {
  void Promise.resolve()
    .then(() => window.mixdogDesktop.invokeCapability({ capability: 'prepareTranscription', args: [] }))
    .catch(() => {
      // Ignored on purpose; see above.
    });
}

export function withTranscript(draft: string, text: string): string {
  if (!draft) return text;
  return `${draft}${/\s$/.test(draft) ? '' : ' '}${text}`;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Recorded audio could not be read.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
}

function microphoneFailureText(reason: unknown): string {
  const name = reason instanceof DOMException ? reason.name : '';
  if (name === 'NotAllowedError') {
    return isRemoteHostRenderer()
      ? 'Microphone access is blocked. Allow microphone access for this site in your browser settings and reload.'
      : 'Microphone access is blocked. Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was detected. Connect one and try again.';
  }
  if (name === 'NotReadableError') return 'The microphone is busy in another app. Close it and try again.';
  return reason instanceof Error ? reason.message : String(reason);
}

/** Tracks whether voice transcription is installed and enabled (on mount, on
 *  setup and runtime changes, on reconnect). Losing it bumps `generation` so
 *  in-flight takes drop their results, and runs `onLost` to end the live take. */
function useVoiceStatus(
  setStatus: (status: VoiceStatus | undefined) => void,
  availableRef: MutableRefObject<boolean>,
  generation: MutableRefObject<number>,
  onLost: () => void
): void {
  useEffect(() => {
    let live = true;
    let latest = 0;
    const adopt = (status?: VoiceStatus) => {
      const available = status?.installed === true && status.enabled === true;
      if (!available && availableRef.current) {
        generation.current += 1;
        onLost();
      }
      availableRef.current = available;
      setStatus(status);
    };
    const refresh = () => {
      const seq = ++latest;
      void Promise.resolve()
        .then(() => window.mixdogDesktop.invokeCapability<VoiceStatus>({ capability: 'getVoiceStatus', args: [] }))
        .then(
          (answer) => {
            if (live && seq === latest) adopt(answer?.value);
          },
          () => {
            if (live && seq === latest) adopt();
          }
        );
    };
    const onRuntimeChanged = (event: Event) => {
      const status = (event as CustomEvent<VoiceStatus>).detail;
      if (typeof status?.installed === 'boolean' && typeof status.enabled === 'boolean') {
        latest += 1;
        adopt(status);
      } else refresh();
    };
    refresh();
    const stopSetup = subscribeSetupChanges(refresh);
    window.addEventListener('mixdog:voice-runtime-changed', onRuntimeChanged);
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, refresh);
    return () => {
      live = false;
      stopSetup();
      window.removeEventListener('mixdog:voice-runtime-changed', onRuntimeChanged);
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, refresh);
    };
  }, [availableRef, generation, onLost, setStatus]);
}

/** Milliseconds since `since` while a take is recording, refreshed twice a second. */
function useRecordingElapsed(state: DictationState, since: number): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (state !== 'recording' || !since) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - since);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - since), 500);
    return () => window.clearInterval(timer);
  }, [state, since]);
  return elapsedMs;
}

export function useComposerDictation({
  identityScope,
  transitioningRef,
  textarea,
  setDraft,
  invokeResult,
  showNotice,
  requestVoiceInstall,
  onTranscriptSubmit,
  keysActive = true,
}: {
  /** This composer is the focused pane's: only then do Enter and Esc reach
   *  its take (a window capture listener would otherwise take them from the
   *  pane the user is typing in). */
  keysActive?: boolean;
  /** The conversation the composer shows when it mounts; `moveTo` follows it from then on. */
  identityScope: string;
  transitioningRef: MutableRefObject<boolean>;
  textarea: MutableRefObject<HTMLTextAreaElement | null>;
  setDraft: Dispatch<SetStateAction<string>>;
  invokeResult<T>(action: () => T | Promise<T>): Promise<T | undefined>;
  showNotice(message: string, tone?: 'info' | 'error'): void;
  requestVoiceInstall(): void;
  /** A take ended by `stopDictationAndSend` produced `text`: the composer sends it, joined to its draft, and calls
   *  `settle` in the run that sends it (`true`) or once it cannot go out (`false`: the words then join the draft). The
   *  overlay stays up until then; cancelling it meanwhile (`cancelled()`) stops the send. Without this, the words join
   *  the draft. */
  onTranscriptSubmit?(text: string, take: { settle(sent: boolean): void; cancelled(): boolean }): void;
}) {
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  // Off screen (a retained or parked conversation) the composer owns no mic.
  const surfaceActive = useSurfaceActive();
  const surfaceActiveRef = useRef(surfaceActive);
  surfaceActiveRef.current = surfaceActive;
  // Elapsed time backs the composer's recording overlay: the disc alone
  // never told the user how long the mic had been live.
  const [recordingSince, setRecordingSince] = useState(0);
  // Smoothed 0..1 input level, read by the overlay's own animation frame.
  const dictationLevelRef = useRef(0);
  // The take whose microphone is still being opened; cancelling it releases
  // the stream the moment getUserMedia hands it over.
  const dictationAttempt = useRef<{ cancelled: boolean } | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>();
  const recordingElapsedMs = useRecordingElapsed(dictationState, recordingSince);
  const dictationAvailable = voiceStatus?.installed === true && voiceStatus.enabled === true;
  const voiceAvailableRef = useRef(false);
  const voiceGeneration = useRef(0);
  const conversation = useRef(identityScope);
  const mounted = useRef(true);
  const dictationSession = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    cancelled: boolean;
    submitOnStop: boolean;
    stopTimer: number;
    meter: DictationMeter | null;
    /** Audio is actually being captured (state `recording`). */
    live: boolean;
    /** The conversation the take was started in: its words land in that one's draft. */
    home: string;
  } | null>(null);
  // The latest take, kept until its words land (the recording session above ends when the recorder stops).
  const latestTake = useRef<{ home: string } | null>(null);
  // The upload and transcription in flight. It is the only phase with nothing local to end it, so cancelling it
  // drops the result instead of waiting on a daemon that may never answer.
  const transcription = useRef<{ cancelled: boolean } | null>(null);

  /** Discards a take whose microphone is still opening; true when one was. */
  const cancelPendingAttempt = useCallback((): boolean => {
    const pending = dictationAttempt.current;
    if (!pending) return false;
    pending.cancelled = true;
    dictationAttempt.current = null;
    setDictationState('idle');
    return true;
  }, []);

  const discardTakeOnVoiceLoss = useCallback(() => {
    cancelPendingAttempt();
    const active = dictationSession.current;
    if (!active) return;
    active.cancelled = true;
    stopRecorder(active.recorder);
    for (const track of active.stream.getTracks()) track.stop();
  }, [cancelPendingAttempt]);
  useVoiceStatus(setVoiceStatus, voiceAvailableRef, voiceGeneration, discardTakeOnVoiceLoss);

  const toggleDictation = useCallback(async () => {
    if (dictationState === 'transcribing' || transitioningRef.current) return;
    const active = dictationSession.current;
    if (active) {
      // Stopped while still preparing, the take holds no speech: onstop
      // discards it instead of transcribing.
      stopRecorder(active.recorder);
      return;
    }
    if (dictationAttempt.current) return;
    const attempt = { cancelled: false };
    dictationAttempt.current = attempt;
    let opened: MediaStream | null = null;
    try {
      // Installation status is already refreshed on mount and runtime changes.
      // Never put a server round trip ahead of microphone capture: on remote
      // connections that wait silently discarded the start of the utterance.
      if (!voiceAvailableRef.current) {
        if (voiceStatus?.installed === false) {
          requestVoiceInstall();
          showNotice('Install voice transcription from Extensions first.');
        } else if (voiceStatus?.enabled === false) {
          showNotice('Turn on voice transcription in Extensions to dictate.');
        } else showNotice('Voice transcription is unavailable on this host.');
        return;
      }
      const generation = voiceGeneration.current;
      setDictationState('preparing');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 16_000 },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (attempt.cancelled || generation !== voiceGeneration.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      opened = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 });
      const session = {
        recorder,
        stream,
        chunks: [] as Blob[],
        cancelled: false,
        submitOnStop: false,
        stopTimer: 0,
        meter: null as DictationMeter | null,
        live: false,
        home: conversation.current,
      };
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onstart = () => {
        void whenTrackLive(stream).then(() => {
          if (session.cancelled || recorder.state === 'inactive' || dictationSession.current !== session) return;
          session.live = true;
          setRecordingSince(Date.now());
          setDictationState('recording');
          warmTranscription();
        });
      };
      recorder.onstop = () => {
        void (async () => {
          window.clearTimeout(session.stopTimer);
          stopLevelMeter(session.meter, dictationLevelRef);
          session.meter = null;
          // A take the composer moved away from (`moveTo`) is no longer its own: it transcribes out of sight, and the
          // composer's state and overlay stay the shown conversation's.
          const own = dictationSession.current === session;
          if (own) dictationSession.current = null;
          for (const track of session.stream.getTracks()) track.stop();
          if (session.cancelled || !session.live || session.chunks.length === 0) {
            if (own) setDictationState('idle');
            return;
          }
          const run = { cancelled: false };
          if (own) {
            setDictationState('transcribing');
            transcription.current = run;
          }
          /** The words join the draft of the conversation they were spoken in, parked when another is shown or the
           *  composer is gone. */
          const land = (text: string) => {
            if (mounted.current && session.home === conversation.current) {
              setDraft((current) => withTranscript(current, text));
            } else stashComposerDraft(session.home, withTranscript(stashedComposerDraft(session.home), text));
          };
          let handedOff = false;
          try {
            const blob = new Blob(session.chunks, {
              type: recorder.mimeType || 'audio/webm',
            });
            const dataUrl = await blobDataUrl(blob);
            if (run.cancelled || generation !== voiceGeneration.current) return;
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            // A discarded take's late failure is not the user's to see: it never reaches the error banner.
            const result = await invokeResult(() =>
              window.mixdogDesktop
                .invokeCapability<string>({
                  capability: 'transcribeAudio',
                  args: [{ data: base64, mimeType: blob.type }],
                })
                .catch((reason: unknown) => {
                  if (run.cancelled) return undefined;
                  throw reason;
                })
            );
            if (run.cancelled || generation !== voiceGeneration.current) return;
            const text = String(result?.value ?? '').trim();
            // No longer the composer's own take (moved away, closed): the words wait in its draft, and nothing is sent.
            if (text && transcription.current !== run) {
              land(text);
              return;
            }
            // Only a take that produced words is allowed to send itself. A
            // silent or failed transcription falls back to the ordinary
            // draft, so nothing is ever posted blind. The words of a take sent
            // go to the send, never through the editor first.
            if (text && session.submitOnStop && onTranscriptSubmit) {
              handedOff = true;
              let settled = false;
              onTranscriptSubmit(text, {
                settle: (sent) => {
                  if (settled) return;
                  settled = true;
                  if (!sent) land(text);
                  if (transcription.current === run) {
                    transcription.current = null;
                    setDictationState('idle');
                  }
                },
                // Cancelled, moved away from or closed while the send waited.
                cancelled: () => transcription.current !== run,
              });
            } else if (text) {
              land(text);
              // Editing a transcript needs the caret; sending it directly does
              // not (and must not reopen the mobile keyboard).
              if (!session.submitOnStop) {
                window.setTimeout(() => {
                  if (surfaceActiveRef.current) textarea.current?.focus();
                }, 0);
              }
            }
          } finally {
            if (!handedOff && transcription.current === run) {
              transcription.current = null;
              setDictationState('idle');
            }
          }
        })();
      };
      recorder.start();
      dictationSession.current = session;
      latestTake.current = session;
      session.meter = startLevelMeter(stream, dictationLevelRef);
      session.stopTimer = window.setTimeout(() => stopRecorder(recorder), 120_000);
    } catch (reason) {
      // Recording never started: the mic it opened is released, so the next tap starts a new take.
      for (const track of opened?.getTracks() ?? []) track.stop();
      // A cancelled attempt already went idle; a newer take may own the state.
      if (attempt.cancelled) return;
      showNotice(microphoneFailureText(reason), 'error');
      setDictationState('idle');
    } finally {
      if (dictationAttempt.current === attempt) dictationAttempt.current = null;
    }
  }, [
    voiceStatus,
    dictationState,
    invokeResult,
    onTranscriptSubmit,
    requestVoiceInstall,
    setDraft,
    showNotice,
    textarea,
    transitioningRef,
  ]);

  const stopDictationAndSend = useCallback(() => {
    const active = dictationSession.current;
    if (!active || active.cancelled) return;
    active.submitOnStop = true;
    stopRecorder(active.recorder);
  }, []);

  // Discarding is its own path: `toggleDictation` always transcribes what it
  // stopped, so a take started by mistake had no way back (overlay ×, Esc).
  const cancelDictation = useCallback(() => {
    if (cancelPendingAttempt()) return;
    const running = transcription.current;
    if (running) {
      running.cancelled = true;
      transcription.current = null;
      setDictationState('idle');
      return;
    }
    const active = dictationSession.current;
    if (!active) return;
    active.cancelled = true;
    stopRecorder(active.recorder);
  }, [cancelPendingAttempt]);

  /** Ends the take in the conversation it was started in: the mic is released and its words wait in that draft, never
   *  sent, while the composer gets an idle mic and no overlay at once. */
  const detachTake = useCallback(() => {
    cancelPendingAttempt();
    const active = dictationSession.current;
    dictationSession.current = null;
    transcription.current = null;
    setDictationState('idle');
    if (active) stopRecorder(active.recorder);
  }, [cancelPendingAttempt]);

  /** The composer now shows `next`. A draft that became that session (`sameConversation`) keeps its take; any other
   *  move detaches it. */
  const moveTo = useCallback(
    (next: string, sameConversation: boolean) => {
      const left = conversation.current;
      conversation.current = next;
      if (sameConversation) {
        if (latestTake.current?.home === left) latestTake.current.home = next;
        return;
      }
      detachTake();
    },
    [detachTake]
  );

  useEffect(() => {
    if (!keysActive || !surfaceActive) return undefined;
    if (dictationState === 'idle') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelDictation();
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (dictationState === 'transcribing') return;
      event.preventDefault();
      event.stopPropagation();
      if (dictationState === 'recording') void toggleDictation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancelDictation, dictationState, keysActive, surfaceActive, toggleDictation]);

  useEffect(() => {
    if (surfaceActive) return;
    cancelPendingAttempt();
    const session = dictationSession.current;
    if (session) stopRecorder(session.recorder);
  }, [surfaceActive, cancelPendingAttempt]);

  // A closed composer detaches its take as a switch does.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      detachTake();
    };
  }, [detachTake]);

  return {
    dictationState,
    dictationAvailable,
    toggleDictation,
    stopDictationAndSend,
    cancelDictation,
    moveTo,
    recordingElapsedMs,
    dictationLevelRef,
  };
}
