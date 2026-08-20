import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type DictationState = "idle" | "recording" | "transcribing";

type DictationMeter = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  frame: number;
};

// The recording overlay paints its bars from a ref, never from React state: a
// per-frame level in state would re-render the whole composer (model pickers
// included) for as long as the user keeps speaking.
function startLevelMeter(stream: MediaStream, level: { current: number }): DictationMeter | null {
  const Context = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
  try { meter.source.disconnect(); } catch { /* already disconnected */ }
  try { meter.analyser.disconnect(); } catch { /* already disconnected */ }
  void Promise.resolve(meter.context.close()).catch(() => {
    // Closing the graph is best-effort during teardown.
  });
}

export function useComposerDictation({
  transitioningRef,
  textarea,
  setDraft,
  invokeResult,
  showNotice,
}: {
  transitioningRef: MutableRefObject<boolean>;
  textarea: MutableRefObject<HTMLTextAreaElement | null>;
  setDraft: Dispatch<SetStateAction<string>>;
  invokeResult<T>(action: () => T | Promise<T>): Promise<T | undefined>;
  showNotice(message: string, durationMs?: number): void;
}) {
  const [dictationState, setDictationState] = useState<DictationState>("idle");
  // Elapsed time backs the composer's recording overlay: the disc alone
  // never told the user how long the mic had been live (user-flagged).
  const [recordingSince, setRecordingSince] = useState(0);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  // Smoothed 0..1 input level, read by the overlay's own animation frame.
  const dictationLevelRef = useRef(0);
  const dictationSession = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    cancelled: boolean;
    stopTimer: number;
    meter: DictationMeter | null;
  } | null>(null);

  const toggleDictation = useCallback(async () => {
    if (dictationState === "transcribing" || transitioningRef.current) return;
    const active = dictationSession.current;
    if (active) {
      try {
        active.recorder.stop();
      } catch {
        // The recorder already stopped.
      }
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((device) => device.kind === "audioinput")) {
        showNotice("No microphone was detected. Connect one and try again.");
        return;
      }
      // Transcription needs intelligibility, not fidelity: engines resample to
      // 16 kHz mono anyway, and 24 kbps Opus is transparent for speech. The
      // browser default (48 kHz stereo, 48-64 kbps) sent two to three times
      // the bytes over a phone link for no gain in accuracy. Every constraint
      // is `ideal`, so a device that cannot honour one still records.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 16_000 },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 24_000 });
      const session = {
        recorder,
        stream,
        chunks: [] as Blob[],
        cancelled: false,
        stopTimer: 0,
        meter: null as DictationMeter | null,
      };
      dictationSession.current = session;
      session.meter = startLevelMeter(stream, dictationLevelRef);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onstop = () => {
        void (async () => {
          window.clearTimeout(session.stopTimer);
          stopLevelMeter(session.meter, dictationLevelRef);
          session.meter = null;
          dictationSession.current = null;
          for (const track of session.stream.getTracks()) track.stop();
          if (session.cancelled || session.chunks.length === 0) {
            setDictationState("idle");
            return;
          }
          setDictationState("transcribing");
          try {
            const blob = new Blob(session.chunks, {
              type: recorder.mimeType || "audio/webm",
            });
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(
                reader.error || new Error("Recorded audio could not be read."),
              );
              reader.onload = () => resolve(String(reader.result || ""));
              reader.readAsDataURL(blob);
            });
            const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
            const result = await invokeResult(() =>
              window.mixdogDesktop.invokeCapability<string>({
                capability: "transcribeAudio",
                args: [{ data: base64, mimeType: blob.type }],
              }));
            const text = String(result?.value ?? "").trim();
            if (text) {
              setDraft((current) => current
                ? `${current}${/\s$/.test(current) ? "" : " "}${text}`
                : text);
              window.setTimeout(() => textarea.current?.focus(), 0);
            }
          } finally {
            setDictationState("idle");
          }
        })();
      };
      recorder.start();
      session.stopTimer = window.setTimeout(() => {
        try {
          recorder.stop();
        } catch {
          // The recorder already stopped.
        }
      }, 120_000);
      setRecordingSince(Date.now());
      setDictationState("recording");
    } catch (reason) {
      const name = reason instanceof DOMException ? reason.name : "";
      showNotice(name === "NotAllowedError"
        ? ((window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer
          ? "Microphone access is blocked. Allow microphone access for this site in your browser settings and reload."
          : "Microphone access is blocked. Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.")
        : name === "NotFoundError" || name === "OverconstrainedError"
          ? "No microphone was detected. Connect one and try again."
          : name === "NotReadableError"
            ? "The microphone is busy in another app. Close it and try again."
            : reason instanceof Error ? reason.message : String(reason));
      setDictationState("idle");
    }
  }, [dictationState, invokeResult, setDraft, showNotice, textarea, transitioningRef]);

  // Discarding is its own path: `toggleDictation` always transcribes what it
  // stopped, so a take started by mistake had no way back (overlay ×, Esc).
  const cancelDictation = useCallback(() => {
    const active = dictationSession.current;
    if (!active) return;
    active.cancelled = true;
    try {
      active.recorder.stop();
    } catch {
      // The recorder already stopped.
    }
  }, []);

  // Enter finishes the take, Esc discards it. Capture phase, because the
  // composer's own Escape policy would otherwise clear the draft and Enter
  // would send it while the mic is still live.
  useEffect(() => {
    if (dictationState !== "recording") return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelDictation();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void toggleDictation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancelDictation, dictationState, toggleDictation]);

  useEffect(() => {
    if (dictationState !== "recording" || !recordingSince) {
      setRecordingElapsedMs(0);
      return;
    }
    setRecordingElapsedMs(Date.now() - recordingSince);
    const timer = window.setInterval(() => {
      setRecordingElapsedMs(Date.now() - recordingSince);
    }, 500);
    return () => window.clearInterval(timer);
  }, [dictationState, recordingSince]);

  useEffect(() => () => {
    const session = dictationSession.current;
    if (!session) return;
    session.cancelled = true;
    stopLevelMeter(session.meter, dictationLevelRef);
    session.meter = null;
    try {
      session.recorder.stop();
    } catch {
      // Teardown remains best-effort.
    }
    for (const track of session.stream.getTracks()) track.stop();
  }, []);

  return { dictationState, toggleDictation, cancelDictation, recordingElapsedMs, dictationLevelRef };
}
