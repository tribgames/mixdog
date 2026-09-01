export function shouldRecordVisualOnlyCapabilityMiss(
  semanticAccessibilityAvailable: boolean,
  accessibilityError: string,
): boolean {
  return !semanticAccessibilityAvailable && !accessibilityError;
}

export function captureAccessibilityError(
  visualOnlyCacheHit: boolean,
  responseOk: boolean,
  requestError: string,
  responseError: string,
): string {
  if (visualOnlyCacheHit || responseOk) return '';
  return requestError || responseError || 'capture accessibility snapshot failed';
}

export function shouldRunCaptureOcr(
  ocrFallbackEnabled: boolean,
  semanticAccessibilityAvailable: boolean,
  explicitlyRequested: boolean,
): boolean {
  return ocrFallbackEnabled
    && (explicitlyRequested || !semanticAccessibilityAvailable);
}

export interface VisualOnlyCapability {
  misses: number;
  expiresAt: number;
}

export function createVisualOnlyCapabilityStore(maxEntries = 128) {
  const byTarget = new Map<string, VisualOnlyCapability>();
  return {
    resolve(
      targetKey: string,
      now: number,
    ): { capability?: VisualOnlyCapability; cacheHit: boolean } {
      const capability = byTarget.get(targetKey);
      const cacheHit = Boolean(capability && capability.expiresAt > now);
      if (capability) {
        byTarget.delete(targetKey);
        if (cacheHit) byTarget.set(targetKey, capability);
      }
      return { capability, cacheHit };
    },
    remember(targetKey: string, capability: VisualOnlyCapability): void {
      byTarget.delete(targetKey);
      byTarget.set(targetKey, capability);
      while (byTarget.size > maxEntries) {
        const oldestKey = byTarget.keys().next().value;
        if (oldestKey === undefined) break;
        byTarget.delete(oldestKey);
      }
    },
    delete(targetKey: string): void {
      byTarget.delete(targetKey);
    },
    releasePrefix(prefix: string): void {
      for (const key of byTarget.keys()) {
        if (key.startsWith(prefix)) byTarget.delete(key);
      }
    },
  };
}

export interface OcrCapturePreference {
  includeOcr: boolean;
  ocrLanguage?: string;
  maxOcrWords?: number;
}

const MAX_OCR_CAPTURE_PREFERENCE_SESSIONS = 128;

export function createOcrCapturePreferenceStore() {
  const bySession = new Map<string, OcrCapturePreference>();
  return {
    remember(sessionId: string, preference: OcrCapturePreference): void {
      if (!preference.includeOcr) {
        bySession.delete(sessionId);
        return;
      }
      bySession.delete(sessionId);
      bySession.set(sessionId, { ...preference });
      while (bySession.size > MAX_OCR_CAPTURE_PREFERENCE_SESSIONS) {
        const oldest = bySession.keys().next().value;
        if (oldest === undefined) break;
        bySession.delete(oldest);
      }
    },
    resolve(
      sessionId: string,
      override: Partial<OcrCapturePreference>,
    ): OcrCapturePreference {
      const remembered = bySession.get(sessionId);
      if (remembered) {
        bySession.delete(sessionId);
        bySession.set(sessionId, remembered);
      }
      const includeOcr = override.includeOcr ?? remembered?.includeOcr ?? false;
      return includeOcr ? {
        includeOcr,
        ocrLanguage: override.ocrLanguage ?? remembered?.ocrLanguage,
        maxOcrWords: override.maxOcrWords ?? remembered?.maxOcrWords,
      } : { includeOcr: false };
    },
    release(sessionId: string): void {
      bySession.delete(sessionId);
    },
  };
}
