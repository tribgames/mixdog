// What this browser container is, as the desktop sees it: the id the relay
// routes to and the human label an approval prompt or a push registration
// shows. Nothing here touches the socket, so both answers are available before
// any connection exists.

export const newBrowserId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
};

export const browserProfile = async (): Promise<{ name: string; platform: string; browser: string }> => {
  const userAgent = navigator.userAgent || '';
  let platform = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    'Unknown device'
  ).slice(0, 80);
  // Ordered: Edge and iOS Chrome also carry the Chrome and Safari tokens.
  const browserFamilies: Array<[RegExp, string]> = [
    [/Edg\//u, 'Edge'],
    [/Firefox\//u, 'Firefox'],
    [/CriOS\//u, 'Chrome'],
    [/Chrome\//u, 'Chrome'],
    [/Safari\//u, 'Safari'],
  ];
  const browser = browserFamilies.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Browser';
  // Device identity (user: 무슨 기기인지도 나와야): Android Chromium exposes
  // the hardware model via UA-Client Hints (e.g. "Pixel 8", "SM-S928N");
  // Apple never does, so iPhone/iPad fall back to the UA family.
  let model = '';
  try {
    const uaData = (
      navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
        };
      }
    ).userAgentData;
    if (uaData?.getHighEntropyValues) {
      const high = await uaData.getHighEntropyValues(['model', 'platform']);
      if (typeof high.model === 'string' && high.model.trim()) {
        model = high.model.trim().slice(0, 40);
      }
      if (typeof high.platform === 'string' && high.platform) {
        platform = String(high.platform).slice(0, 80);
      }
    }
  } catch {
    /* UA-CH unavailable; the platform label stands */
  }
  if (!model) {
    if (/iPhone/u.test(userAgent)) model = 'iPhone';
    else if (/iPad|Macintosh.+Mobile/u.test(userAgent)) model = 'iPad';
  }
  // "Pixel 8 · Chrome" when the device is known; "Android · Chrome" otherwise.
  return { name: `${model || platform} · ${browser}`, platform, browser };
};
