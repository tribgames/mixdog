import { Check, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Approval } from "./desktop-types";
import { t } from "./i18n";
import { isApprovalDismissKey } from "./renderer-logic.mjs";
import { asRecord, textOf } from "./text-format";

function approvalText(value: unknown, preferredKey: string): string {
  const preferred = asRecord(value)?.[preferredKey];
  return (typeof preferred === "string" ? preferred : textOf(value)).trim();
}

function localPreviewUrl(path: unknown): string {
  const value = String(path || "").replace(/\\/g, "/");
  return value ? `file:///${encodeURI(value).replace(/^\/+/, "")}` : "";
}

export function ApprovalCard({ approval, resolve }: {
  approval: Approval;
  resolve: (approved: boolean) => Promise<unknown>;
}) {
  const reason = approvalText(approval.reason, "message")
    || t("Review this tool request before continuing.");
  const cwd = approvalText(approval.cwd, "path");
  const args = asRecord(approval.args);
  const action = String(args?.action || "").toLowerCase();
  const officeTransaction = String(approval.name || "").toLowerCase() === "office"
    && ["commit", "rollback", "discard"].includes(action);
  const transaction = asRecord(args?.transaction);
  const diff = asRecord(transaction?.diff);
  const summary = asRecord(diff?.summary);
  const preview = asRecord(args?.preview);
  const visualDiff = asRecord(preview?.visualDiff);
  const previewImages = [
    ...(Array.isArray(preview?.images) ? preview.images : []),
    ...(Array.isArray(visualDiff?.images) ? visualDiff.images : []),
  ].map(asRecord).filter((image): image is Record<string, unknown> => Boolean(image?.path)).slice(0, 4);
  const actionLabel = action === "commit"
    ? t("Commit changes")
    : action === "rollback"
      ? t("Roll back")
      : t("Discard recovery");
  const [resolving, setResolving] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const resolvingRef = useRef(false);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const decide = useCallback(async (approved: boolean) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setApprovalError("");
    setResolving(true);
    try {
      const accepted = await resolveRef.current(approved);
      if (accepted === true) return;
      setApprovalError(t("Mixdog could not record this decision. Please try again."));
      resolvingRef.current = false;
      setResolving(false);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason || "");
      setApprovalError(detail
        ? t("Mixdog could not record this decision: {{detail}}", { detail })
        : t("Mixdog could not record this decision. Please try again."));
      resolvingRef.current = false;
      setResolving(false);
    }
  }, []);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []);
    (focusable()[0] || dialog.current)?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)) return;
      const shortcut = event.key.toLowerCase();
      if (shortcut === "a" || shortcut === "y" || shortcut === "d" || shortcut === "n") {
        event.preventDefault();
        event.stopPropagation();
        void decide(shortcut === "a" || shortcut === "y");
        return;
      }
      if (isApprovalDismissKey(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        void decide(false);
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previousFocus?.focus();
    };
  }, [decide]);
  // Inline approval: the request renders in the
  // transcript flow with a warning ring instead of a modal overlay, so the
  // user can keep reading and typing while deciding.
  return (
    <article ref={dialog} className="approval-card approval-card--inline" role="group"
      aria-labelledby="approval-title" aria-describedby="approval-description"
      >
      <div className="approval-heading"><span><ShieldAlert size={18} /></span>
        <div><b id="approval-title">{officeTransaction
          ? t("Office transaction review")
          : t("Tool approval required")}</b>
          <small>{officeTransaction
            ? actionLabel
            : t("{{name}} wants to run", { name: String(approval.name || t("Tool")) })}</small></div>
      </div>
      <p id="approval-description">{reason}</p>
      <dl>
        {cwd && <><dt>{t("Folder")}</dt><dd>{cwd}</dd></>}
        {officeTransaction && Boolean(args?.document) && <><dt>{t("Document")}</dt><dd><code>{String(args?.document)}</code></dd></>}
        {officeTransaction && Boolean(transaction?.id) && <><dt>{t("Transaction")}</dt><dd><code>{String(transaction?.id)}</code></dd></>}
        {officeTransaction && summary && <><dt>{t("Changes")}</dt><dd>
          {t("{{total}} paths · +{{added}} −{{removed}} ~{{modified}}", {
            total: Number(summary.total || 0),
            added: Number(summary.added || 0),
            removed: Number(summary.removed || 0),
            modified: Number(summary.modified || 0),
          })}
        </dd></>}
        {officeTransaction && Boolean(preview?.output) && <><dt>{t("Preview")}</dt><dd><code>{String(preview?.output)}</code></dd></>}
        {officeTransaction && visualDiff?.available === true && <><dt>{t("Visual diff")}</dt><dd>
          {t("{{percent}}% changed pixels", { percent: Number(visualDiff.changedPercent || 0) })}
        </dd></>}
        {!officeTransaction && approval.args != null && <><dt>{t("Arguments")}</dt><dd><code>{textOf(approval.args)}</code></dd></>}
      </dl>
      {officeTransaction && previewImages.length > 0 && <div className="office-approval-preview"
        aria-label={t("Document preview")}>
        {previewImages.map((image, index) => <figure key={`${String(image.path)}:${index}`}>
          <img src={localPreviewUrl(image.path)} alt={image.kind === "visual-diff"
            ? t("Visual diff page {{page}}", { page: Number(image.page || index + 1) })
            : t("Preview page {{page}}", { page: Number(image.page || index + 1) })} />
          <figcaption>{image.kind === "visual-diff" ? t("Visual diff") : t("Preview")}</figcaption>
        </figure>)}
      </div>}
      {approvalError && <p className="approval-error" role="alert" aria-live="assertive">
        {approvalError}
      </p>}
      <div className="approval-actions">
        <button disabled={resolving} onClick={() => void decide(false)}><X size={16} /> {
          officeTransaction ? t("Keep editing") : t("Deny")
        }</button>
        <button disabled={resolving} className="allow" onClick={() => void decide(true)}>
          <Check size={16} /> {officeTransaction ? actionLabel : t("Allow once")}</button>
      </div>
    </article>
  );
}
