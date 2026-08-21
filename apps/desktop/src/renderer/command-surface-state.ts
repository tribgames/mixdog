import type { CommandSurface as CommandSurfaceName } from "./slash-commands";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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
