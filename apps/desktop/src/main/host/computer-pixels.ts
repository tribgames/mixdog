/**
 * `host/computer/pixels`: one capture of a display or of a window of the app, encoded here and uploaded to the core's blob
 * store with `blob/put` before the answer, which is the blob reference. The desktop keeps no capture
 * state: the core owns the frames and chooses the backend; the attempts tried ride the answer and a failed capture's error.
 */
import type {
  HostComputerPixelsParams,
  HostComputerPixelsResult,
} from "../../../../../packages/protocol/src/index.ts";
import {
  acquirePixels,
  electronPixelSources,
  PixelsError,
  type PixelBackend,
  type PixelRequest,
  type PixelSources,
} from "../computer/pixels/acquire";
import { type CallCore, uploadBlob } from "../computer/pixels/blob-upload";
import { encodeImage, type PixelFormat } from "../computer/pixels/encode";
import {
  HOST_COMMAND_FAILED,
  HOST_INVALID_PARAMS,
  HostRpcError,
  type HostConnection,
  objectParams,
  type WireFields,
} from "./connection";

export const HOST_COMPUTER_PIXELS = "host/computer/pixels";

export interface ComputerPixelsDeps {
  /** A request to the core (`blob/put`). */
  callCore: CallCore;
  /** The capturers; the Electron ones when absent. */
  sources?: PixelSources;
  /** The core's `limits.maxBlobPutChunkBytes`, when known; uploads never exceed it. */
  blobChunkBytes?: () => number | undefined;
}

const MAX_DIMENSION = 2 ** 31 - 1;

const invalid = (reason: string): HostRpcError =>
  new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_PIXELS}: ${reason}`);

const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) > 0 &&
  (value as number) <= MAX_DIMENSION;

const isBackend = (value: unknown): value is PixelBackend =>
  value === "screen" || value === "app_owned" || value === "composited";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

interface Checked {
  request: PixelRequest;
  format: PixelFormat;
  quality: number;
}

function checked(params: WireFields<HostComputerPixelsParams>): Checked {
  const { backend, maxWidth, maxHeight, format, quality } = params;
  const target = record(params.target);
  if (!target || (target.kind !== "display" && target.kind !== "window"))
    throw invalid("target.kind is display or window");
  if (!isBackend(backend)) throw invalid("unknown backend");
  if (!positive(maxWidth)) throw invalid("maxWidth is a positive integer");
  if (maxHeight !== undefined && !positive(maxHeight))
    throw invalid("maxHeight is a positive integer");
  if (format !== "jpeg" && format !== "png")
    throw invalid("format is jpeg or png");
  if (
    typeof quality !== "number" ||
    !Number.isSafeInteger(quality) ||
    quality < 1 ||
    quality > 100
  ) {
    throw invalid("quality is 1..100");
  }
  let region: PixelRequest["region"];
  if (params.region !== undefined) {
    const { x, y, width, height } = record(params.region) ?? {};
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      !positive(width) ||
      !positive(height)
    ) {
      throw invalid("region is whole pixels with a size");
    }
    region = { x, y, width, height };
  }
  const base = { backend, maxWidth, maxHeight, region };
  if (target.kind === "window") {
    if (typeof target.windowId !== "string" || !target.windowId)
      throw invalid("target.windowId is required");
    return {
      request: {
        ...base,
        target: { kind: "window", windowId: target.windowId },
      },
      format,
      quality,
    };
  }
  const { displayId, index } = target;
  if (displayId !== undefined && typeof displayId !== "string")
    throw invalid("target.displayId is a string");
  if (
    index !== undefined &&
    (typeof index !== "number" || !Number.isSafeInteger(index))
  ) {
    throw invalid("target.index is a whole number");
  }
  return {
    request: { ...base, target: { kind: "display", displayId, index } },
    format,
    quality,
  };
}

export function registerComputerPixels(
  connection: HostConnection,
  deps: ComputerPixelsDeps,
): void {
  let loaded: Promise<PixelSources> | undefined;
  const sourcesOf = (): Promise<PixelSources> =>
    deps.sources
      ? Promise.resolve(deps.sources)
      : (loaded ??= electronPixelSources());
  connection.handleRequest(
    HOST_COMPUTER_PIXELS,
    async (params, signal): Promise<HostComputerPixelsResult> => {
      const wire = objectParams<HostComputerPixelsParams>(
        params,
        HOST_COMPUTER_PIXELS,
      );
      const { request, format, quality } = checked(wire);
      try {
        const pixels = await acquirePixels(await sourcesOf(), request, signal);
        const encoded = encodeImage(pixels.image, format, quality);
        const { digest, byteLength } = await uploadBlob(
          deps.callCore,
          encoded.bytes,
          deps.blobChunkBytes?.(),
        );
        const size = pixels.image.getSize();
        return {
          blob: { digest, byteLength, mimeType: encoded.mimeType },
          captureWidth: size.width,
          captureHeight: size.height,
          source: pixels.source,
          backend: pixels.backend,
          capturedAt: Date.now(),
          attempts: pixels.attempts,
        };
      } catch (error) {
        if (error instanceof HostRpcError) throw error;
        if (error instanceof PixelsError) {
          if (error.code === "invalid_params") throw invalid(error.message);
          throw new HostRpcError(HOST_COMMAND_FAILED, error.message, {
            code: error.code,
            attempts: error.attempts,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new HostRpcError(HOST_COMMAND_FAILED, message, {
          code: "computer_capture_unavailable",
        });
      }
    },
  );
}
