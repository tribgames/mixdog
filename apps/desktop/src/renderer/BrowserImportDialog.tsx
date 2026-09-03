import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Cookie,
  History,
  KeyRound,
  LoaderCircle,
  X,
} from "lucide-react";

import type {
  DesktopBrowserImportItem,
  DesktopBrowserImportProgress,
  DesktopBrowserImportSource,
} from "../shared/contract";
import { t } from "./i18n";

interface BrowserImportDialogProps {
  open: boolean;
  onClose: () => void;
}

const EMPTY_ITEMS: Record<DesktopBrowserImportItem, boolean> = {
  passwords: false,
  cookies: false,
  history: false,
};

function supportedItems(
  source: DesktopBrowserImportSource | undefined,
): Record<DesktopBrowserImportItem, boolean> {
  return {
    passwords: source?.supports.passwords === true,
    cookies: source?.supports.cookies === true,
    history: source?.supports.history === true,
  };
}

export function BrowserImportDialog({
  open,
  onClose,
}: BrowserImportDialogProps) {
  const desktopApi = window.mixdogDesktop;
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const [sources, setSources] = useState<DesktopBrowserImportSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [items, setItems] = useState<Record<DesktopBrowserImportItem, boolean>>(EMPTY_ITEMS);
  const [administratorApproved, setAdministratorApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<
    Partial<Record<DesktopBrowserImportItem, DesktopBrowserImportProgress>>
  >({});

  busyRef.current = busy;

  const requestClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled)",
      )?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), select:not(:disabled), input:not(:disabled)",
      )].filter((element) => element.offsetParent !== null || element === document.activeElement);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open, requestClose]);

  useEffect(() => {
    if (!open || !desktopApi?.browserProfileImportSources) return undefined;
    let live = true;
    setLoading(true);
    setFinished(false);
    setError("");
    setProgress({});
    setAdministratorApproved(false);
    void desktopApi.browserProfileImportSources().then((nextSources) => {
      if (!live) return;
      setSources(nextSources);
      const source = nextSources[0];
      const profile = source?.profiles[0];
      setSourceId(source?.id || "");
      setProfileId(profile?.id || "");
      setItems(supportedItems(source));
      if (!source || !profile) setError(t("Could not find any importable Chrome profiles."));
    }).catch((reason) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [desktopApi, open]);

  useEffect(() => {
    if (!desktopApi?.onBrowserProfileImportProgress) return undefined;
    return desktopApi.onBrowserProfileImportProgress((update) => {
      setProgress((current) => ({
        ...current,
        [update.item]: update,
      }));
    });
  }, [desktopApi]);

  const selectedSource = sources.find((source) => source.id === sourceId);
  const selectedItems = (Object.keys(items) as DesktopBrowserImportItem[])
    .filter((item) => items[item]);
  const sensitiveSelected = selectedItems.some((item) =>
    (item === "passwords" || item === "cookies")
    && selectedSource?.supports[item] === true);

  const startImport = useCallback(() => {
    if (!desktopApi?.browserProfileImportStart || busyRef.current) return;
    const requestedItems = (Object.keys(items) as DesktopBrowserImportItem[])
      .filter((item) => items[item]);
    if (!requestedItems.length) {
      setError(t("Select at least one item to import."));
      return;
    }
    const requiresApproval = requestedItems.some((item) =>
      (item === "passwords" || item === "cookies")
      && selectedSource?.supports[item] === true);
    if (requiresApproval && !administratorApproved) {
      setError(t("Acknowledge administrator approval to import passwords and cookies."));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFinished(false);
    setError("");
    setProgress({});
    void desktopApi.browserProfileImportStart({
      jobId: crypto.randomUUID().replaceAll("-", ""),
      sourceId,
      profileId,
      items: requestedItems,
      administratorApproved,
    }).then((result) => {
      setFinished(true);
      const failures = Object.values(result.errors).filter(Boolean);
      if (failures.length) setError(failures.join("\n"));
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  }, [
    administratorApproved,
    desktopApi,
    items,
    profileId,
    selectedSource,
    sourceId,
  ]);

  const importItemRow = (
    item: DesktopBrowserImportItem,
    label: string,
    icon: React.ReactNode,
  ) => {
    const supported = selectedSource?.supports[item] !== false;
    const itemProgress = progress[item];
    const selected = supported && items[item];
    const showProgress = (busy || finished) && selected;
    const progressState = itemProgress?.state || (busy ? "running" : "failed");
    return <label className={`browser-import-item${supported ? "" : " is-disabled"}`}>
      <span className="browser-import-item-icon">{icon}</span>
      <span className="browser-import-item-label">
        <strong>{label}</strong>
        {!supported && (selectedSource?.supportReasons?.[item]
          || (item === "passwords" ? selectedSource?.passwordSupportReason : ""))
          ? <small>{selectedSource?.supportReasons?.[item]
            || selectedSource?.passwordSupportReason}</small>
          : null}
        {showProgress && progressState === "completed"
          ? <small>{t("{{total}} imported", { total: itemProgress?.count?.toLocaleString() || "0" })}</small>
          : null}
        {showProgress && progressState === "failed"
          ? <small>{t("Failed to import")}</small>
          : null}
      </span>
      {showProgress
        ? <span className={`browser-import-state is-${progressState}`}
          aria-label={progressState === "completed" ? t("Completed") : progressState === "failed" ? t("Failed") : t("In progress")}>
          {progressState === "completed"
            ? <Check size={16} />
            : progressState === "failed"
              ? <AlertTriangle size={16} />
              : <LoaderCircle size={16} className="is-spinning" />}
        </span>
        : busy || finished
          ? <span className="browser-import-skipped">{t("Excluded")}</span>
          : <input type="checkbox"
            checked={supported && items[item]}
            disabled={!supported || loading}
            onChange={(event) => setItems((current) => ({
              ...current,
              [item]: event.target.checked,
            }))} />}
    </label>;
  };

  if (!open) return null;

  return <div className="browser-import-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) requestClose();
  }}>
    <section ref={dialogRef} className="browser-import-dialog" role="dialog" aria-modal="true"
      aria-labelledby="browser-import-title" aria-describedby="browser-import-description">
      <header>
        <div>
          <h2 id="browser-import-title">{t("Import from browser")}</h2>
          <p id="browser-import-description">{busy
            ? t("Importing browser data…")
            : finished
              ? error
                ? t("Some data could not be imported")
                : t("Browser data imported")
              : t("Select data to import into the built-in browser")}</p>
        </div>
        {!busy && <button type="button" className="browser-pane-nav-button"
          onClick={requestClose} aria-label={t("Close")}>
          <X size={16} />
        </button>}
      </header>
      {!busy && !finished && <div className="browser-import-source">
        <span>{t("Source")}</span>
        <select value={`${sourceId}\u0000${profileId}`}
          aria-label={t("Chrome profile to import")}
          disabled={loading}
          onChange={(event) => {
            const [nextSourceId, nextProfileId] = event.target.value.split("\u0000");
            const source = sources.find((candidate) => candidate.id === nextSourceId);
            setSourceId(nextSourceId);
            setProfileId(nextProfileId);
            setItems(supportedItems(source));
            setAdministratorApproved(false);
          }}>
          {sources.flatMap((source) => source.profiles.map((profile) =>
            <option key={`${source.id}:${profile.id}`}
              value={`${source.id}\u0000${profile.id}`}>
              {source.name} · {profile.name}{profile.accountEmail ? ` (${profile.accountEmail})` : ""}
            </option>))}
        </select>
      </div>}
      <div className="browser-import-items">
        {importItemRow("passwords", t("Saved passwords"), <KeyRound size={18} />)}
        {importItemRow("cookies", t("Cookies"), <Cookie size={18} />)}
        {importItemRow("history", t("Browsing history"), <History size={18} />)}
      </div>
      {!busy && !finished && sensitiveSelected && <label className="browser-import-admin">
        <strong>{t("Administrator approval required")}</strong>
        <span className="browser-import-admin-check">
          <input type="checkbox" checked={administratorApproved}
            onChange={(event) => setAdministratorApproved(event.target.checked)} />
          {t("I understand the app requests administrator approval to import Chrome data")}
        </span>
      </label>}
      {error && <div className="browser-import-error" role="alert">{error}</div>}
      <footer>
        <button type="button" className="browser-import-secondary"
          disabled={busy} onClick={requestClose}>
          {finished ? t("Close") : t("Cancel")}
        </button>
        {(!finished || Boolean(error)) && <button type="button" className="browser-import-primary"
          disabled={
            busy
            || loading
            || !profileId
            || !selectedItems.length
            || (sensitiveSelected && !administratorApproved)
          }
          onClick={startImport}>
          {busy ? <LoaderCircle size={15} className="is-spinning" /> : null}
          {finished ? t("Retry") : t("Import")}
        </button>}
      </footer>
    </section>
  </div>;
}
