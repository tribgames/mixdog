import {
  useEffect,
  useRef
} from "react";
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { t } from "./i18n";
import { acquireModalLayer } from "./modal-layer";
import { acquireTitleBarDim } from "./titlebar-dim";

export * from "./desktop-toasts";
export { InlineErrors } from "./ErrorNotice";

export function DesktopUpdateDialog({ version, onCancel, onConfirm }: {
  version: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const layer = acquireModalLayer(shell ? [shell] : []);
    layer.attachSurface(surfaceRef.current);
    cancelRef.current?.focus({ preventScroll: true });
    // The scrim cannot reach the NATIVE caption band; this claim dims it.
    const captionDim = acquireTitleBarDim();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []);
      if (!controls.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current < 0 || current === controls.length - 1 ? 0 : current + 1);
      event.preventDefault();
      controls[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      layer.release();
      captionDim();
      prior?.focus({ preventScroll: true });
    };
  }, [onCancel]);

  return createPortal(<div ref={surfaceRef} className="settings-confirm-layer"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
    <section ref={dialogRef} className="settings-confirm-dialog desktop-update-dialog"
      role="alertdialog" aria-modal="true" aria-labelledby="desktop-update-title"
      aria-describedby="desktop-update-description" tabIndex={-1}
      data-desktop-update-dialog>
      <header>
        <h3 id="desktop-update-title">{t("Install Mixdog {{version}}?", { version })}</h3>
        <button type="button" aria-label={t("Close update confirmation")} onClick={onCancel}>
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      <p id="desktop-update-description">
        {t("Mixdog will close while the update is installed, then reopen automatically.")}
      </p>
      <footer>
        <button ref={cancelRef} type="button" onClick={onCancel}>{t("Cancel")}</button>
        <button type="button" className="primary" onClick={onConfirm}>{t("Install and restart")}</button>
      </footer>
    </section>
  </div>, document.body);
}
