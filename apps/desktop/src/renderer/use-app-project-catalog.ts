import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopProjectSummary } from "../shared/contract";
import type { Snapshot } from "./desktop-types";
import { isMobileRemoteSurface } from "./MobileTabOverview";
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
  const refreshProjects = useCallback(async (
    options: { acceptEmpty?: boolean } = {},
  ) => {
    const listProjects = window.mixdogDesktop?.listProjects;
    if (!listProjects) return [];
    const next = await listProjects();
    const accepted = acceptedProjectCatalog(
      Array.isArray(next) ? next : [],
      options.acceptEmpty !== false,
    );
    if (accepted) {
      setProjects(accepted);
      setProjectCatalogValidated(true);
      writeCachedProjectCatalog(accepted);
    }
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    void refreshProjects({
      // An empty phone result before relay connection is not authoritative.
      acceptEmpty: !isMobileRemoteSurface(),
    }).catch(() => []).finally(() => {
      if (live) setProjectCatalogReady(true);
    });
    return () => { live = false; };
  }, [refreshProjects]);

  useEffect(() => {
    const retry = () => {
      void refreshProjects({ acceptEmpty: false }).catch(() => undefined);
    };
    const revalidate = () => {
      void refreshProjects({ acceptEmpty: true }).catch(() => undefined);
    };
    window.addEventListener("mixdog:remote-state-gap", retry);
    window.addEventListener("mixdog:remote-reconnected", revalidate);
    return () => {
      window.removeEventListener("mixdog:remote-state-gap", retry);
      window.removeEventListener("mixdog:remote-reconnected", revalidate);
    };
  }, [refreshProjects]);

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
