import { t } from "./i18n";

// The session runtime writes a failed turn's reason as one fixed English
// sentence (presentErrorText / transportErrorText), optionally carrying a
// diagnostic code in parentheses. Those sentences are the translation keys;
// the code survives untranslated so the user can still report it.
// Static t() literals so the catalog extractor keeps every key.
const FIXED_REASONS: ReadonlyMap<string, () => string> = new Map([
  ["Connection to the provider was lost", () => t("Connection to the provider was lost")],
  ["Could not reach the provider", () => t("Could not reach the provider")],
  ["The provider did not respond in time", () => t("The provider did not respond in time")],
  ["Provider TLS certificate check failed", () => t("Provider TLS certificate check failed")],
  ["Provider is temporarily unavailable", () => t("Provider is temporarily unavailable")],
  ["Provider is busy at capacity", () => t("Provider is busy at capacity")],
  ["Provider authentication failed", () => t("Provider authentication failed")],
  ["Session state changed unexpectedly", () => t("Session state changed unexpectedly")],
  ["Context too large", () => t("Context too large")],
  ["Compact failed", () => t("Compact failed")],
]);

const FIXED_REASON_RE = /^(.+?)(?:\s+\(([^()]+)\))?\.?$/;

/** Localize a runtime failure reason when it is one of the fixed sentences;
 *  anything else is shown verbatim. */
export function localizedTurnFailureReason(reason: string): string {
  const text = String(reason || "").trim();
  if (!text) return "";
  const match = FIXED_REASON_RE.exec(text);
  const localize = match ? FIXED_REASONS.get(match[1] as string) : undefined;
  if (!match || !localize) return text;
  const sentence = localize();
  return match[2] ? `${sentence} (${match[2]})` : sentence;
}
