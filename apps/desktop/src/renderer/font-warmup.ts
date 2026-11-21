import { inputQuietRemainingMs } from './boot-warmup';
import { connectionQuality, isRemoteSurface } from './network-conditions';
import { resolveUiLanguage } from './i18n';

const REMOTE_WARMUP_BATCH = 6;
// Measured: one pass over all 90+ Hangul slices held the main thread 100–240ms.
const LOCAL_WARMUP_BATCH = 12;
// The first screen's own transfers own the link until then.
const REMOTE_WARMUP_DELAY_MS = 3_000;

function loadFace(face: FontFace): Promise<unknown> {
  try {
    return face.load().catch(() => undefined);
  } catch {
    // A single broken face must not stop the warmup.
    return Promise.resolve();
  }
}

export function scheduleFontWarmup(): void {
  try {
    if (!document.fonts || typeof document.fonts.forEach !== 'function') return;
    const remote = isRemoteSurface();
    if (remote && connectionQuality() !== 'normal') return;
    const idleSlice: (callback: () => void) => unknown =
      typeof window.requestIdleCallback === 'function'
        ? (callback) => window.requestIdleCallback(callback, { timeout: 2_000 })
        : (callback) => window.setTimeout(callback, 250);
    const idle = (callback: () => void): void => {
      idleSlice(() => {
        const wait = inputQuietRemainingMs();
        if (wait > 0) window.setTimeout(() => idle(callback), wait);
        else callback();
      });
    };
    const warmHangul = !remote || resolveUiLanguage() === 'ko';
    const pending: FontFace[] = [];
    document.fonts.forEach((face) => {
      if (face.status !== 'unloaded') return;
      if (!warmHangul && /pretendard/i.test(face.family)) return;
      // Math loads the faces it actually uses, including on desktop. Its
      // styles are already present for the first equation.
      if (/katex/i.test(face.family)) return;
      pending.push(face);
    });
    if (pending.length === 0) return;
    // Remote batches also keep the warmup from competing with the
    // session/transcript traffic the user is actually waiting on.
    const batch = remote ? REMOTE_WARMUP_BATCH : LOCAL_WARMUP_BATCH;
    let index = 0;
    const step = (): void => {
      try {
        const slice = pending.slice(index, index + batch);
        index += batch;
        if (slice.length === 0) return;
        void Promise.allSettled(slice.map(loadFace)).then(() => {
          if (index < pending.length) idle(step);
        });
      } catch {
        /* warmup is a cosmetic guard */
      }
    };
    if (remote) window.setTimeout(() => idle(step), REMOTE_WARMUP_DELAY_MS);
    else idle(step);
  } catch {
    /* warmup is a cosmetic guard */
  }
}
