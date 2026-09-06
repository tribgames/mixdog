import { t } from "./i18n";
import "./initial-surface.css";

/** A neutral first-read state, never a claim that the result is empty.
 * Cached content stays with its owner; these slots are only for cold reads. */
export function InitialSurface({
  variant = "list",
}: {
  variant?: "list" | "control" | "icon";
}) {
  return <div className={`initial-surface initial-surface--${variant}`}
    role="status" aria-label={t("Loading…")} aria-busy="true">
    <span className="initial-surface-shapes" aria-hidden="true">
      <i /><i /><i />
    </span>
  </div>;
}
