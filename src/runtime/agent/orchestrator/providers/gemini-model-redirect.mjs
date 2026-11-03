/**
 * gemini-model-redirect.mjs — model ids the Gemini API serves as another
 * model, and the models that ignore the deprecated sampling parameters.
 *
 * Redirects (https://aistudio.google.com/docs/changelog.md, 2026-11-02, and
 * docs/deprecations.md): effective December 1, 2026 every API request to
 * `gemini-2.5-pro` routes to `gemini-3.8-flash` and every request to
 * `gemini-2.5-flash` routes to `gemini-3.5-flash-lite`, billed at the target's
 * rates; `gemini-2.5-flash-lite` is not affected. No time zone is documented,
 * so the date is taken as UTC midnight.
 */
const REDIRECT_FROM_MS = Date.parse('2026-12-01T00:00:00Z');
const REDIRECTS = new Map([
  ['gemini-2.5-pro', 'gemini-3.8-flash'],
  ['gemini-2.5-flash', 'gemini-3.5-flash-lite'],
]);

const bareId = (model) =>
  String(model || '')
    .replace(/^models\//i, '')
    .toLowerCase();

/** The id the API serves `model` as at `nowMs`, or null when it is served as itself. */
export function geminiRedirectTarget(model, nowMs = Date.now()) {
  if (nowMs < REDIRECT_FROM_MS) return null;
  return REDIRECTS.get(bareId(model)) ?? null;
}

/**
 * True for models that ignore `temperature`/`top_p`/`top_k`: "Starting with
 * Gemini 3.6 Flash and Gemini 3.5 Flash-Lite ... these models and all future
 * Gemini model releases" (docs/whats-new-gemini-3.6.md#api-changes-and-parameter-updates;
 * changelog 2026-07-21). `gemini-3.5-flash` is routed to `gemini-3.6-flash`
 * (deprecations.md), so it is served by a model that ignores them too.
 */
export function geminiIgnoresSamplingParams(model) {
  const bare = bareId(model);
  if (/^gemini-3\.5-flash(?:-lite)?$/.test(bare)) return true;
  const version = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/.exec(bare);
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] || 0);
  return major >= 4 || (major === 3 && minor >= 6);
}
