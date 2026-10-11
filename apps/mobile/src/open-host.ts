import { extractPairingLink, rememberHost, type HostBook } from './hosts.ts';

export interface OpenHostDeps {
  getBook(): HostBook;
  setBook(book: HostBook): void;
  saveBook(): Promise<void>;
  syncOrigins(): Promise<void>;
  /** False once the pairing attempt was cancelled; checked after every await. */
  isCurrent(): boolean;
  onRedeemed(name: string): void;
  navigate(url: string): void;
  now(): number;
}

/** Remember the host and open it. A cancelled attempt never navigates, and if
 *  Cancel lands while the host is being persisted the previous book is restored. */
export async function openHostFlow(
  deps: OpenHostDeps,
  url: string,
  redeemed?: { name: string; ticket: string }
): Promise<void> {
  const link = extractPairingLink(url);
  if (!link || !deps.isCurrent()) return;
  const previous = deps.getBook();
  deps.setBook(rememberHost(previous, link, deps.now(), redeemed?.name));
  await deps.saveBook();
  if (!deps.isCurrent()) return rollback(deps, previous);
  await deps.syncOrigins();
  if (!deps.isCurrent()) return rollback(deps, previous);
  if (redeemed) deps.onRedeemed(redeemed.name);
  // The one-time ticket rides the fragment (never sent to the relay with the
  // page request); the relay web app uses it for its first claim.
  const hostParam = redeemed?.name ? `&host=${encodeURIComponent(redeemed.name)}` : '';
  deps.navigate(redeemed ? `${link.url}#pair=${redeemed.ticket}${hostParam}` : link.url);
}

async function rollback(deps: OpenHostDeps, previous: HostBook): Promise<void> {
  deps.setBook(previous);
  await deps.saveBook();
  await deps.syncOrigins();
}
