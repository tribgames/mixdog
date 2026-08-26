import type { CommandSurface as CommandSurfaceName } from "./slash-commands";
import { record } from "./record-utils";

export function commandSurfaceSessionId(
  surface: CommandSurfaceName,
  explicitSessionId: unknown,
  snapshot: unknown,
): string {
  if (surface !== "context" && surface !== "inherit") return "";
  return String(explicitSessionId || record(snapshot).sessionId || "").trim();
}

export function commandSurfaceCacheKey(
  surface: CommandSurfaceName,
  sessionId: string,
): string {
  return surface === "context" || surface === "inherit"
    ? `${surface}:${sessionId}`
    : surface;
}

export function commandSurfaceDisplaySnapshot(
  data: Record<string, unknown>,
  fallback: unknown,
): unknown {
  return data.snapshot ?? fallback;
}
