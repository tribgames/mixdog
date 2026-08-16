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
  const dictationSession = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    cancelled: boolean;
    stopTimer: number;
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      const session = {
        recorder,
        stream,
        chunks: [] as Blob[],
        cancelled: false,
        stopTimer: 0,
      };
      dictationSession.current = session;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onstop = () => {
        void (async () => {
          window.clearTimeout(session.stopTimer);
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

  useEffect(() => () => {
    const session = dictationSession.current;
    if (!session) return;
    session.cancelled = true;
    try {
      session.recorder.stop();
    } catch {
      // Teardown remains best-effort.
    }
    for (const track of session.stream.getTracks()) track.stop();
  }, []);

  return { dictationState, toggleDictation };
}
