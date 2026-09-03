import { useCallback, useEffect, useState } from "react";
import type { DesktopUpdaterState } from "../shared/contract";

type Invoke = (action: () => unknown) => Promise<void>;

export function useDesktopUpdater(invoke: Invoke) {
  const [state, setState] = useState<DesktopUpdaterState>({ status: "disabled" });
  const [ready, setReady] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (state.status !== "ready") setDialogOpen(false);
  }, [state.status]);

  useEffect(() => {
    const host = window.mixdogDesktop;
    let live = true;
    const getState = host?.getUpdaterState;
    if (typeof getState !== "function") {
      setReady(true);
    } else {
      void getState().then((next) => {
        if (live) setState(next);
      }).catch(() => {}).finally(() => {
        if (live) setReady(true);
      });
    }
    const unsubscribe = host?.subscribeUpdaterState?.((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  const openDialog = useCallback(() => {
    if (state.status === "ready") setDialogOpen(true);
  }, [state.status]);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const install = useCallback(() => {
    setDialogOpen(false);
    void invoke(async () => {
      const next = await window.mixdogDesktop.showDesktopUpdate();
      setState(next);
    });
  }, [invoke]);

  return {
    state,
    ready,
    dialogOpen,
    openDialog,
    closeDialog,
    install,
  };
}
