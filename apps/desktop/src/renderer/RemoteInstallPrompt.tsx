import { useEffect, useState } from "react";

import { t } from "./i18n";
import { isIosInstallPlatform, remoteInstallMode } from "./remote-install";
import "./remote-install-prompt.css";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function installedStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// Dismissal must survive reloads: state-only dismissal made the card resurface
// on EVERY boot — on Android right after the first tap, when Chromium fires
// beforeinstallprompt (user: 부트 후 첫 클릭에 하단 창이 올라옴).
const DISMISSED_STORAGE_KEY = "mixdog-remote-install-dismissed";

function storedDismissed(): boolean {
  try { return localStorage.getItem(DISMISSED_STORAGE_KEY) === "1"; } catch { return false; }
}

export function RemoteInstallPrompt() {
  const remote = Boolean(
    (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer,
  );
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(installedStandalone);
  const [dismissed, setDismissed] = useState(storedDismissed);
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISSED_STORAGE_KEY, "1"); } catch { /* session only */ }
  };
  const ios = isIosInstallPlatform(
    navigator.userAgent,
    navigator.platform,
    navigator.maxTouchPoints,
  );

  useEffect(() => {
    if (!remote) return undefined;
    const receivePrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    const installed = () => {
      setStandalone(true);
      setInstallEvent(null);
    };
    window.addEventListener("beforeinstallprompt", receivePrompt);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", receivePrompt);
      window.removeEventListener("appinstalled", installed);
    };
  }, [remote]);

  const mode = remoteInstallMode({
    remote,
    standalone,
    dismissed,
    canPrompt: Boolean(installEvent),
    ios,
  });
  if (mode === "hidden") return null;

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    if (choice.outcome === "accepted") setStandalone(true);
  };

  return <aside className="remote-install-prompt" aria-label={t("Install Mixdog")}>
    <div>
      <b>{t("Install Mixdog")}</b>
      <span>{mode === "ios"
        ? t("Tap Share, then Add to Home Screen.")
        : t("Open Mixdog like an app from your home screen or desktop.")}</span>
    </div>
    {mode === "prompt" && <button type="button" className="remote-install-prompt__install"
      onClick={() => void install()}>{t("Install")}</button>}
    <button type="button" className="remote-install-prompt__dismiss"
      aria-label={t("Dismiss install prompt")} onClick={dismiss}>×</button>
  </aside>;
}
