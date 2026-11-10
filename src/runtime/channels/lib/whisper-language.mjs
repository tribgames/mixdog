// Whisper transcription language detection. Module-scoped memoization of the
// resolved device language mirrors a file-level `let`.
let resolvedWhisperLanguage = null;

function normalizeWhisperLanguage(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'auto') return null;
  // POSIX pseudo-locales (LANG=C / C.UTF-8 / POSIX) carry no language signal;
  // treating them as a language poisoned detection ('c.utf-8' reached whisper
  // and blocked the ko-KR Intl fallback from ever being consulted).
  if (raw === 'c' || raw === 'posix' || raw.startsWith('c.') || raw.startsWith('posix.')) return null;
  for (const language of ['ko', 'ja', 'en', 'zh', 'de', 'fr', 'es', 'it', 'pt', 'ru']) {
    if (raw.startsWith(language)) return language;
  }
  return raw;
}

function detectDeviceLanguage() {
  if (resolvedWhisperLanguage) return resolvedWhisperLanguage;
  const candidates = [
    process.env.MIXDOG_CHANNELS_WHISPER_LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWhisperLanguage(candidate);
    if (normalized) {
      resolvedWhisperLanguage = normalized;
      return normalized;
    }
  }
  resolvedWhisperLanguage = 'auto';
  return resolvedWhisperLanguage;
}

export { normalizeWhisperLanguage, detectDeviceLanguage };
