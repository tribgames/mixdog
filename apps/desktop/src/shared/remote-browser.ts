import type { DesktopRemoteBrowserControl } from "./contract";

const MAX_REMOTE_BROWSER_COORDINATE = 100_000;
const MAX_REMOTE_BROWSER_DELTA = 20_000;

function requiredFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return number;
}

function requiredPoint(value: unknown, label: string): { x: number; y: number } {
  if (!value || typeof value !== "object") throw new TypeError(`${label} is invalid.`);
  const point = value as Record<string, unknown>;
  return {
    x: requiredFiniteNumber(point.x, `${label}.x`, 0, MAX_REMOTE_BROWSER_COORDINATE),
    y: requiredFiniteNumber(point.y, `${label}.y`, 0, MAX_REMOTE_BROWSER_COORDINATE),
  };
}

export function normalizeRemoteBrowserFrameId(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || !/^rbf_[a-z0-9]+$/iu.test(value)) {
    throw new TypeError("remote browser frame id is invalid.");
  }
  return value;
}

export function normalizeRemoteBrowserControl(value: unknown): DesktopRemoteBrowserControl {
  if (!value || typeof value !== "object") {
    throw new TypeError("remote browser control is invalid.");
  }
  const input = value as Record<string, unknown>;
  const type = String(input.type || "");
  const requiredFrameId = (): string => {
    const frameId = normalizeRemoteBrowserFrameId(input.frameId);
    if (!frameId) throw new TypeError("remote browser control requires a frame id.");
    return frameId;
  };
  if (type === "navigate") {
    if (typeof input.url !== "string" || input.url.length < 1 || input.url.length > 4_096) {
      throw new TypeError("remote browser url is invalid.");
    }
    return { type, url: input.url };
  }
  if (type === "back" || type === "forward" || type === "reload" || type === "stop") {
    return { type };
  }
  if (type === "tap") {
    return { type, frameId: requiredFrameId(), ...requiredPoint(input, "remote browser tap") };
  }
  if (type === "swipe") {
    return {
      type,
      frameId: requiredFrameId(),
      from: requiredPoint(input.from, "remote browser swipe start"),
      to: requiredPoint(input.to, "remote browser swipe end"),
    };
  }
  if (type === "scroll") {
    return {
      type,
      frameId: requiredFrameId(),
      ...requiredPoint(input, "remote browser scroll"),
      deltaX: requiredFiniteNumber(
        input.deltaX,
        "remote browser horizontal scroll",
        -MAX_REMOTE_BROWSER_DELTA,
        MAX_REMOTE_BROWSER_DELTA,
      ),
      deltaY: requiredFiniteNumber(
        input.deltaY,
        "remote browser vertical scroll",
        -MAX_REMOTE_BROWSER_DELTA,
        MAX_REMOTE_BROWSER_DELTA,
      ),
    };
  }
  if (type === "text") {
    if (typeof input.text !== "string" || input.text.length < 1 || input.text.length > 2_000) {
      throw new TypeError("remote browser text is invalid.");
    }
    return { type, frameId: requiredFrameId(), text: input.text };
  }
  if (type === "key") {
    if (typeof input.key !== "string" || input.key.length < 1 || input.key.length > 64) {
      throw new TypeError("remote browser key is invalid.");
    }
    return { type, frameId: requiredFrameId(), key: input.key };
  }
  throw new TypeError(`unknown remote browser control "${type || "(none)"}".`);
}

export interface RemoteBrowserImageBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Map a pointer through an object-fit:contain image, rejecting letterbox taps. */
export function remoteBrowserImagePoint(
  bounds: RemoteBrowserImageBounds,
  source: { width: number; height: number },
  client: { x: number; y: number },
): { x: number; y: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0 || source.width <= 0 || source.height <= 0) {
    return null;
  }
  const scale = Math.min(bounds.width / source.width, bounds.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  if (client.x < left || client.x > left + width || client.y < top || client.y > top + height) {
    return null;
  }
  return {
    x: Math.min(source.width, Math.max(0, (client.x - left) / scale)),
    y: Math.min(source.height, Math.max(0, (client.y - top) / scale)),
  };
}
