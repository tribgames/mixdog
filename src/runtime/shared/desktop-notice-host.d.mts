export interface RaisedDesktopNotice {
  key: string;
  code: string;
  params: Record<string, string>;
}
export function raiseDesktopNotice(key: string, code: string, params?: Record<string, unknown>): boolean;
export function clearDesktopNotice(key: string): void;
export function deliverPendingDesktopNotices(): void;
/** `sink` returns false when it had nobody to deliver to; the notice then
 *  waits and is offered again with `replay` true. */
export function registerDesktopNoticeSink(
  sink: (notice: RaisedDesktopNotice, replay: boolean) => boolean | undefined
): () => void;
