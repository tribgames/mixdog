import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";

type LoadMetric = {
  token: number;
  startedAt: number;
  stages: Set<string>;
};

let studioMetric: LoadMetric | null = null;
const editorMetrics = new Map<string, LoadMetric>();
let nextMetricToken = 0;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function perfLog(line: string): void {
  try {
    if (typeof window !== "undefined") window.mixdogDesktop?.perfLog?.(line);
  } catch {
    // Performance diagnostics must never become a loading failure.
  }
}

function cleanField(value: string): string {
  return String(value || "").replace(/\s+/g, "_").slice(-160);
}

export function editorLoadKey(projectPath: string, relPath: string, accessToken?: string): string {
  return `${String(projectPath || "").replace(/\\/g, "/").toLocaleLowerCase()}::`
    + `${String(relPath || "").replace(/\\/g, "/").toLocaleLowerCase()}::${accessToken || ""}`;
}

export function beginEditorLoad(projectPath: string, relPath: string, accessToken?: string): void {
  beginBootSurface("editor", editorLoadKey(projectPath, relPath, accessToken));
  editorMetrics.set(editorLoadKey(projectPath, relPath, accessToken), {
    token: ++nextMetricToken,
    startedAt: now(),
    stages: new Set(),
  });
}

export function ensureEditorLoad(projectPath: string, relPath: string, accessToken?: string): void {
  const key = editorLoadKey(projectPath, relPath, accessToken);
  if (!editorMetrics.has(key)) beginEditorLoad(projectPath, relPath, accessToken);
}

export function reportEditorLoadStage(
  projectPath: string,
  relPath: string,
  accessToken: string | undefined,
  stage: string,
  details = "",
  complete = false,
): void {
  const key = editorLoadKey(projectPath, relPath, accessToken);
  const metric = editorMetrics.get(key);
  if (!metric || metric.stages.has(stage)) return;
  metric.stages.add(stage);
  reportBootSurfaceStage("editor", key, stage, details);
  const suffix = details ? ` ${details}` : "";
  perfLog(
    `editor-load stage=${cleanField(stage)} total=${Math.max(0, now() - metric.startedAt).toFixed(1)}ms`
    + ` file=${cleanField(relPath)}${suffix}`,
  );
  if (complete) reportBootSurfaceReady("editor", key, details);
  if (complete) editorMetrics.delete(key);
}

export function beginStudioLoad(): number {
  beginBootSurface("studio", "studio");
  studioMetric = { token: ++nextMetricToken, startedAt: now(), stages: new Set() };
  return studioMetric.token;
}

export function ensureStudioLoad(): number {
  beginBootSurface("studio", "studio");
  studioMetric ||= { token: ++nextMetricToken, startedAt: now(), stages: new Set() };
  return studioMetric.token;
}

export function reportStudioLoadStage(
  stage: string,
  details = "",
  complete = false,
  token?: number,
): void {
  const metric = studioMetric;
  if (!metric || (token !== undefined && metric.token !== token) || metric.stages.has(stage)) return;
  metric.stages.add(stage);
  reportBootSurfaceStage("studio", "studio", stage, details);
  const suffix = details ? ` ${details}` : "";
  perfLog(
    `studio-load stage=${cleanField(stage)} total=${Math.max(0, now() - metric.startedAt).toFixed(1)}ms${suffix}`,
  );
  if (complete) reportBootSurfaceReady("studio", "studio", details);
  if (complete) studioMetric = null;
}
