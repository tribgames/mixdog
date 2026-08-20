import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DesktopRemoteClientClaim } from "../shared/contract";
import { t } from "./i18n";
import {
  enqueueRemoteClientClaim,
  normalizeRemoteClientClaim,
  pruneRemoteClientClaims,
} from "./remote-claim-queue";
import {
  isRemoteClaimPromptActive,
  subscribeRemoteClaimPromptActive,
} from "./remote-claim-prompt-state";

// An installed web app runs in its own storage container: it reaches this
// desktop with no credential and asks for one, and the answer here IS the
// grant. The prompt lives in the app's own surface — a native message box
// answered the same question in the wrong skin (user: 우리 테마 팝업이 아니다).
export function RemoteClaimPrompt() {
  const [queue, setQueue] = useState<DesktopRemoteClientClaim[]>([]);
  const [answering, setAnswering] = useState(false);
  const [active, setActive] = useState(isRemoteClaimPromptActive);
  const answeringRef = useRef(false);
  const api = window.mixdogDesktop;

  useEffect(() => {
    if (typeof api?.subscribeRemoteClientClaim !== "function") return undefined;
    return api.subscribeRemoteClientClaim((claim) => {
      const normalized = normalizeRemoteClientClaim(claim);
      if (!normalized) return;
      // A reloaded copy of the same container replaces its stale card instead
      // of stacking another approval behind it.
      setQueue((current) => enqueueRemoteClientClaim(current, normalized));
    });
  }, [api]);

  useEffect(() => subscribeRemoteClaimPromptActive(setActive), []);

  useEffect(() => {
    if (!active || typeof api?.listRemoteClientClaims !== "function") return undefined;
    let live = true;
    void api.listRemoteClientClaims()
      .then((claims) => {
        if (!live) return;
        setQueue((current) => claims.reduce((next, value) => {
          const normalized = normalizeRemoteClientClaim(value);
          return normalized ? enqueueRemoteClientClaim(next, normalized) : next;
        }, current));
      })
      .catch(() => { /* the live event path remains available */ });
    return () => { live = false; };
  }, [active, api]);

  const claim = queue[0];

  useEffect(() => {
    if (!claim) return undefined;
    const expire = () => {
      answeringRef.current = false;
      setAnswering(false);
      setQueue((current) => pruneRemoteClientClaims(current));
    };
    const remaining = claim.expiresAt - Date.now();
    if (remaining <= 0) {
      expire();
      return undefined;
    }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [claim]);

  useEffect(() => {
    if (!claim) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || answeringRef.current) return;
      event.preventDefault();
      void answer(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });

  if (!claim || !active) return null;

  async function answer(approved: boolean): Promise<void> {
    const claimId = claim?.claimId ?? "";
    const resolve = window.mixdogDesktop?.resolveRemoteClientClaim;
    if (!claimId || !resolve || answeringRef.current) return;
    if (claim.expiresAt <= Date.now()) {
      setQueue((current) => pruneRemoteClientClaims(current));
      return;
    }
    answeringRef.current = true;
    setAnswering(true);
    try {
      const handled = await resolve(claimId, approved);
      if (handled) {
        setQueue((current) => current.filter((row) => row.claimId !== claimId));
      } else {
        // The service lost or expired this request. Every queued card came
        // through that same service lifetime, so clear the stale batch rather
        // than walking the user through another approval loop.
        setQueue([]);
      }
    } catch {
      // Keep the live card retryable when IPC itself was temporarily lost.
    } finally {
      answeringRef.current = false;
      setAnswering(false);
    }
  }

  const device = claim.name
    || [claim.platform, claim.browser].filter(Boolean).join(" · ")
    || t("this device");

  return createPortal(<div className="settings-confirm-layer">
    <section className="settings-confirm-dialog" role="alertdialog" aria-modal="true"
      aria-labelledby="remote-claim-title" aria-describedby="remote-claim-description">
      <header>
        <h3 id="remote-claim-title">{t("Connect {{device}}?", { device })}</h3>
      </header>
      <p id="remote-claim-description">
        {t("It is asking to use this desktop. Approve it only if you just opened Mixdog there.")}
      </p>
      <footer>
        <button type="button" disabled={answering}
          onClick={() => { void answer(false); }}>{t("Deny")}</button>
        <button type="button" className="primary" disabled={answering}
          onClick={() => { void answer(true); }}>{t("Approve")}</button>
      </footer>
    </section>
  </div>, document.body);
}
