import { useEffect, useState } from "react";

import { t } from "./i18n";
import { useMobileBack } from "./mobile-back";
import { iosInstallStep, isIosInstallPlatform, remoteInstallMode } from "./remote-install";
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

// An iOS Home Screen app runs in its own storage container, so the pairing this
// browser holds never reaches it. The shim hands out the scanned link only once
// this browser's pairing has actually connected; '' means there is nothing to
// pass on and the plain install hint stands.
function pairingHandoffLink(): string {
  try {
    return (window as unknown as { mixdogRemotePairingHandoff?: () => string })
      .mixdogRemotePairingHandoff?.() || "";
  } catch {
    return "";
  }
}

export function RemoteInstallPrompt() {
  const remote = Boolean(
    (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer,
  );
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(installedStandalone);
  const [dismissed, setDismissed] = useState(storedDismissed);
  const [handoff, setHandoff] = useState(pairingHandoffLink);
  const [prepared, setPrepared] = useState(false);
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISSED_STORAGE_KEY, "1"); } catch { /* session only */ }
  };
  // An iOS install captures the LAUNCHING document url (its manifest variant
  // drops start_url), so restoring the scanned link right before the Share
  // sheet is what makes the installed app open already paired. The clipboard
  // copy is the manual fallback for the pairing screen's paste button, and the
  // next reload strips the link from the address bar again (remote-shim boot).
  const prepareHandoff = () => {
    const link = pairingHandoffLink();
    if (!link) return;
    try { history.replaceState(null, "", link); } catch { /* the url stays clean */ }
    try { void navigator.clipboard?.writeText(link).catch(() => {}); } catch { /* no clipboard */ }
    setHandoff(link);
    setPrepared(true);
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
    // The shim publishes this the first time a pairing actually connects, and
    // only such a browser may pass its pairing to a Home Screen install.
    const paired = () => setHandoff(pairingHandoffLink());
    window.addEventListener("beforeinstallprompt", receivePrompt);
    window.addEventListener("appinstalled", installed);
    window.addEventListener("mixdog:remote-paired", paired);
    return () => {
      window.removeEventListener("beforeinstallprompt", receivePrompt);
      window.removeEventListener("appinstalled", installed);
      window.removeEventListener("mixdog:remote-paired", paired);
    };
  }, [remote]);

  const mode = remoteInstallMode({
    remote,
    standalone,
    dismissed,
    canPrompt: Boolean(installEvent),
    ios,
  });
  // ABB: back dismisses the card instead of leaving the page behind it.
  useMobileBack(mode !== "hidden", dismiss);
  if (mode === "hidden") return null;
  const step = mode === "ios" ? iosInstallStep({ handoff: Boolean(handoff), prepared }) : "plain";

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    if (choice.outcome === "accepted") setStandalone(true);
  };

  // Centered card over a scrim (user: 팝업 화면 중앙에 나오면). The scrim has NO
  // click handler on purpose: only the × closes the card (user: 아니 x로닫히게).
  return <div className="remote-install-scrim">
    <div className="remote-install-card" role="dialog" aria-modal="true"
      aria-label={t("Install Mixdog")}>
      <button type="button" className="remote-install-card__dismiss"
        aria-label={t("Dismiss install prompt")} onClick={dismiss}>×</button>
      <img className="remote-install-card__icon" src="./mixdog.svg" alt="" draggable={false} />
      <b>{t("Install Mixdog")}</b>
      <span>{t("Open Mixdog like an app from your home screen or desktop.")}</span>
      {/* iOS has no install prompt API, so the Share → Add to Home Screen route
          IS the install and gets spelled out. The handoff control sits above the
          steps: the link has to be armed BEFORE the Share sheet opens. */}
      {mode === "ios" && <>
        {step === "prepare" && <button type="button" className="remote-install-card__install"
          onClick={prepareHandoff}>{t("Install")}</button>}
        {step === "share" && <span className="remote-install-card__ready">{t("Ready")}</span>}
        <ol className="remote-install-card__steps">
          <li><i aria-hidden="true">1</i>{t("Tap the Share button")}</li>
          <li><i aria-hidden="true">2</i>{t("Choose Add to Home Screen")}</li>
        </ol>
      </>}
      {mode === "prompt" && <button type="button" className="remote-install-card__install"
        onClick={() => void install()}>{t("Install")}</button>}
    </div>
  </div>;
}
