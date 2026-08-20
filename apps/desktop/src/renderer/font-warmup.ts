// Post-reveal warmup for every declared font face.
//
// The boot gate only guarantees the faces used by the FIRST painted tree.
// Pretendard's dynamic subset declares 92 Hangul range slices that otherwise
// load lazily the first time a menu label, tab title, session row — or a
// TYPED character — reaches a new codepoint range. Each first use re-rendered
// that text a frame later (user: 메뉴 이동 시 새로 생기는 폰트가 튐) and, while
// the slice was still in flight, left the character unpainted (user: 타이핑하는
// 글자가 자꾸 투명해진다).
//
// Warming every slice once removes that class of stall at the source. The
// desktop reads local disk, so it warms in one pass; a browser/phone fetches
// ~2MB over the network, so it warms in small batches during idle time and
// skips the warmup entirely on a metered or very slow connection, where the
// dynamic subset's on-demand behavior is the better trade.
const REMOTE_WARMUP_BATCH = 6;

type NetworkInformation = { saveData?: boolean; effectiveType?: string };

function meteredConnection(): boolean {
  try {
    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (!connection) return false;
    if (connection.saveData === true) return true;
    return /(^|-)2g$/i.test(String(connection.effectiveType || ""));
  } catch {
    return false;
  }
}

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
    if (!document.fonts || typeof document.fonts.forEach !== "function") return;
    const remote = !/electron/i.test(navigator.userAgent);
    if (remote && meteredConnection()) return;
    const idle: (callback: () => void) => unknown =
      typeof window.requestIdleCallback === "function"
        ? (callback) => window.requestIdleCallback(callback, { timeout: 2_000 })
        : (callback) => window.setTimeout(callback, 250);
    const pending: FontFace[] = [];
    document.fonts.forEach((face) => {
      if (face.status === "unloaded") pending.push(face);
    });
    if (pending.length === 0) return;
    // Local faces resolve in single-digit milliseconds, so the desktop pays
    // one idle pass. Remote batches keep the warmup from competing with the
    // session/transcript traffic the user is actually waiting on.
    const batch = remote ? REMOTE_WARMUP_BATCH : pending.length;
    let index = 0;
    const step = (): void => {
      try {
        const slice = pending.slice(index, index + batch);
        index += batch;
        if (slice.length === 0) return;
        void Promise.allSettled(slice.map(loadFace)).then(() => {
          if (index < pending.length) idle(step);
        });
      } catch { /* warmup is a cosmetic guard */ }
    };
    idle(step);
  } catch { /* warmup is a cosmetic guard */ }
}
