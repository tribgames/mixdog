import { NATIVE_DICTATION_EVENT, type NativeDictationEvent, nativeAppInfo } from '../shared/native-app';

type NativeCall = NonNullable<NonNullable<ReturnType<typeof nativeAppInfo>>['call']>;

let nextTake = 1;

function audioBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

/** The Android app's own recorder, shaped like the part of MediaRecorder the composer drives. It is
 *  already capturing when `startNativeDictation` resolves; `onstart` fires once audio flows and
 *  `onlevel` with each captured block's RMS. `onstop` fires the moment it stops, while the phone
 *  still encodes: the take's audio arrives through `audio`. */
export class NativeDictationRecorder {
  state: RecordingState = 'inactive';
  onstart: (() => void) | null = null;
  onlevel: ((rms: number) => void) | null = null;
  onstop: (() => void) | null = null;
  /** `null` when no audio came back: none captured, encoding failed, the reply was lost or the take was discarded. */
  audio: Promise<Blob | null> = Promise.resolve(null);
  private live = false;
  private readonly listener = (event: Event): void => {
    const detail = (event as CustomEvent<NativeDictationEvent>).detail;
    if (detail?.take !== this.take) return;
    if (detail.type === 'ended') {
      if (this.state === 'recording') this.stop();
      return;
    }
    this.onlevel?.(detail.level ?? 0);
    if (this.live) return;
    this.live = true;
    if (this.state === 'recording') this.onstart?.();
  };

  constructor(
    private readonly call: NativeCall,
    readonly take: number
  ) {
    window.addEventListener(NATIVE_DICTATION_EVENT, this.listener);
  }

  start(): void {
    this.state = 'recording';
    if (this.live) this.onstart?.();
  }

  stop(): void {
    if (this.state === 'inactive') throw new DOMException('The recorder already stopped.', 'InvalidStateError');
    this.end();
    this.audio = this.call('stopDictation', { take: this.take }).then(
      (audio) => (audio?.data ? audioBlob(audio.data, audio.mimeType) : null),
      () => null
    );
    this.onstop?.();
  }

  /** Releases the mic with nothing encoded or sent; a recording take still fires `onstop`. */
  discard(): void {
    const recording = this.state === 'recording';
    this.end();
    void this.call('cancelDictation', { take: this.take }).catch(() => {
      // The shell releases it with the page anyway.
    });
    if (recording) this.onstop?.();
  }

  private end(): void {
    this.state = 'inactive';
    window.removeEventListener(NATIVE_DICTATION_EVENT, this.listener);
  }
}

/** `null` at once off the Android app, so the browser mic opens without a yield. The promise
 *  resolves to `null` when the shell cannot record (older app, no mic permission yet): the
 *  browser's getUserMedia then asks for it. */
export function startNativeDictation(): Promise<NativeDictationRecorder | null> | null {
  const native = nativeAppInfo();
  const call = native?.platform === 'android' ? native.call : undefined;
  if (!call) return null;
  const recorder = new NativeDictationRecorder(call, nextTake++);
  return call('startDictation', { take: recorder.take }).then(
    (started) => {
      if (started === true) return recorder;
      recorder.discard();
      return null;
    },
    () => {
      recorder.discard();
      return null;
    }
  );
}
