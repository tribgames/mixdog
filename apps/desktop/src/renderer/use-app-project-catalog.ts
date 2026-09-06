import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopProjectSummary } from "../shared/contract";
import type { Snapshot } from "./desktop-types";
import { isMobileRemoteSurface } from "./MobileTabOverview";
import { createProjectCatalogRequests } from "./project-catalog-requests";
import { currentRemoteConnectionState, subscribeRemoteConnectionState } from "./remote-connection-state";
import {
  acceptedProjectCatalog,
  readCachedProjectCatalog,
  resolveProjectPathAgainstCatalog,
  writeCachedProjectCatalog,
} from "./project-catalog-cache";

function projectPathKey(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLocaleLowerCase();
}

function registeredProjectPath(
  projects: readonly DesktopProjectSummary[],
  candidate: unknown,
): string {
  const key = projectPathKey(candidate);
  if (!key) return "";
  return projects.find((project) => projectPathKey(project.path) === key)?.path || "";
}

export function useAppProjectCatalog(snapshot: Snapshot) {
  const [projects, setProjects] = useState<DesktopProjectSummary[]>(
    readCachedProjectCatalog,
  );
  const [projectCatalogReady, setProjectCatalogReady] = useState(
    () => projects.length > 0 && isMobileRemoteSurface(),
  );
  const [projectCatalogValidated, setProjectCatalogValidated] = useState(false);
  const registeredPath = useCallback(
    (candidate: unknown) => registeredProjectPath(projects, candidate),
    [projects],
  );
  const preferredDraftProjectPath = useMemo(() => {
    const recent = Array.isArray(snapshot.recentProjects) ? snapshot.recentProjects : [];
    const candidates = [
      String(snapshot.currentProject || ""),
      ...recent.map((path) => String(path || "")),
      String(projects[0]?.path || ""),
    ].filter(Boolean);
    if (!projectCatalogValidated) return candidates[0] || "";
    for (const candidate of candidates) {
      const registered = registeredPath(candidate);
      if (registered) return registered;
    }
    return "";
  }, [
    projectCatalogValidated,
    projects,
    registeredPath,
    snapshot.currentProject,
    snapshot.recentProjects,
  ]);
  const effectiveDraftProjectPath = useCallback((candidate: unknown): string => {
    const requested = String(candidate || "").trim();
    return resolveProjectPathAgainstCatalog(
      requested,
      projectCatalogValidated,
      registeredPath(requested),
      preferredDraftProjectPath,
    );
  }, [preferredDraftProjectPath, projectCatalogValidated, registeredPath]);
  const projectRequests = useMemo(() => createProjectCatalogRequests(
    async () => {
      const list = window.mixdogDesktop?.listProjects;
      if (!list) throw new Error("Project catalog is unavailable.");
      return await list();
    },
    (next, acceptEmpty) => {
      const accepted = acceptedProjectCatalog(Array.isArray(next) ? next : [], acceptEmpty);
      if (accepted) {
        setProjects(accepted);
        setProjectCatalogValidated(true);
        writeCachedProjectCatalog(accepted);
      }
    },
  ), []);
  const refreshProjects = projectRequests.refresh;

  useEffect(() => {
    let live = true;
    void refreshProjects({
      // An empty phone result before relay connection is not authoritative.
      acceptEmpty: !isMobileRemoteSurface(),
      coalesce: true,
    }).catch(() => []).finally(() => {
      if (live) setProjectCatalogReady(true);
    });
    return () => { live = false; projectRequests.invalidate(); };
  }, [refreshProjects, projectRequests]);

  useEffect(() => {
    const retry = () => {
      void refreshProjects({ acceptEmpty: false, coalesce: true }).catch(() => undefined);
    };
    const revalidate = () => {
      void refreshProjects({ acceptEmpty: true, coalesce: true }).catch(() => undefined);
    };
    let wasConnected = currentRemoteConnectionState() === "connected";
    const unsubscribe = subscribeRemoteConnectionState(() => {
      const connected = currentRemoteConnectionState() === "connected";
      const lostConnection = wasConnected && !connected;
      wasConnected = connected;
      if (!lostConnection) return;
      projectRequests.invalidate();
      setProjectCatalogValidated(false);
    });
    window.addEventListener("mixdog:remote-state-gap", retry);
    window.addEventListener("mixdog:remote-reconnected", revalidate);
    return () => {
      unsubscribe();
      window.removeEventListener("mixdog:remote-state-gap", retry);
      window.removeEventListener("mixdog:remote-reconnected", revalidate);
    };
  }, [refreshProjects, projectRequests]);

  return {
    projects,
    projectCatalogReady,
    projectCatalogValidated,
    registeredProjectPath: registeredPath,
    preferredDraftProjectPath,
    effectiveDraftProjectPath,
    refreshProjects,
  };
}
