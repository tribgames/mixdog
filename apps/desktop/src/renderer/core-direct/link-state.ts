// What a window can say of its core connection beyond up or down: the attempt the client's ladder is at and, when it has
// ended, why (the client library's failure detail, or the error of a first connection that never came up).
import type { DesktopCoreLink } from '../../shared/contract-sections.ts';

export const UP: DesktopCoreLink = Object.freeze({ attempt: 0, closed: null });

const detailOf = (error: unknown): { kind?: string; reason?: string } | undefined =>
  (error as { detail?: { kind?: string; reason?: string } } | null)?.detail;

/** The link of a connection that has ended with `error` (a client failure carries its detail; any other error is a plain failure). */
export function closedLink(error: unknown): DesktopCoreLink {
  const detail = detailOf(error);
  if (detail?.kind === 'versionRefused' && (detail.reason === 'clientOutdated' || detail.reason === 'serverOutdated')) {
    return { attempt: 0, closed: { cause: detail.reason, message: '' } };
  }
  const message = error instanceof Error && error.message ? error.message : String(detail?.kind ?? error ?? '');
  return { attempt: 0, closed: { cause: 'failed', message } };
}

/** The link a client's status event stands for. */
export function linkOfStatus(status: { state: string; attempt?: number; reason?: unknown }): DesktopCoreLink {
  if (status.state === 'reconnecting') return { attempt: status.attempt ?? 0, closed: null };
  if (status.state === 'closed') return closedLink(status.reason === undefined ? undefined : { detail: status.reason, message: '' });
  return UP;
}
