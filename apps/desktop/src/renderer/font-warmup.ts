// Post-reveal warmup for every declared local font face.
//
// The boot gate only guarantees the faces used by the FIRST painted tree.
// Pretendard's dynamic subset declares ~93 Hangul range slices that otherwise
// load lazily the first time a menu label, tab title, or session row uses a
// new codepoint range — each first use re-rendered that text a frame later
// (user: 메뉴 이동 시 새로 생기는 폰트가 튐). Desktop assets are local disk
// reads, so loading everything once in idle time (~2MB total) removes every
// future lazy font load at the source. Browser/LAN clients keep the
// on-demand subset behavior: warming all slices over the network would defeat
// the dynamic subset's purpose on phones.
export function scheduleFontWarmup(): void {
  try {
    if (!/electron/i.test(navigator.userAgent)) return;
    if (!document.fonts || typeof document.fonts.forEach !== "function") return;
    const idle: (callback: () => void) => unknown =
      typeof window.requestIdleCallback === "function"
        ? (callback) => window.requestIdleCallback(callback, { timeout: 2_000 })
        : (callback) => window.setTimeout(callback, 250);
    idle(() => {
      try {
        const loads: Promise<unknown>[] = [];
        document.fonts.forEach((face) => {
          if (face.status !== "unloaded") return;
          try {
            loads.push(face.load().catch(() => undefined));
          } catch { /* a single broken face must not stop the warmup */ }
        });
        void Promise.allSettled(loads);
      } catch { /* warmup is a cosmetic guard */ }
    });
  } catch { /* warmup is a cosmetic guard */ }
}
