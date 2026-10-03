export interface BrowserNetworkRequest {
  id: string;
  cdpRequestId: string;
  sessionId?: string;
  method: string;
  url: string;
  resourceType: string;
  startedAt: number;
  finishedAt?: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  hasPostData: boolean;
  status?: number;
  statusText?: string;
  responseHeaders: Record<string, string>;
  mimeType?: string;
  protocol?: string;
  remoteAddress?: string;
  encodedDataLength?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  failure?: string;
  canceled?: boolean;
  redirectedTo?: string;
  webSocketFrames?: BrowserWebSocketFrame[];
}

/** This guest runs no extensions, so the only client that refuses a request is
 *  the partition's own request policy (private or internal addresses, DNS
 *  answers that point there, the domain allowlist). Chromium names that
 *  refusal with a bare code that reads like a fault of the page. */
const POLICY_BLOCK = 'net::ERR_BLOCKED_BY_CLIENT';
const POLICY_BLOCK_NOTE = `${POLICY_BLOCK} (Browser Use network policy`;
/** The failure text with the refusal named, and the rule's reason when the
 *  partition recorded one for this URL. */
export function explainNetworkFailure(text: string, reason = ''): string {
  return text.replaceAll(POLICY_BLOCK, `${POLICY_BLOCK_NOTE}${reason ? `: ${reason}` : ''})`);
}

/** At most `limit` of these report lines, in their original order, choosing
 *  the newest faults of the page before the host's own refusals: a tracker
 *  the policy blocked on every load must not crowd out the error that matters. */
export function pageFaultsFirst(lines: string[], limit: number): string[] {
  const picked = new Set<number>();
  for (const refused of [false, true]) {
    for (let index = lines.length - 1; index >= 0 && picked.size < limit; index -= 1) {
      if (lines[index].includes(POLICY_BLOCK_NOTE) === refused) picked.add(index);
    }
  }
  return lines.filter((_, index) => picked.has(index));
}

interface BrowserWebSocketFrame {
  direction: 'sent' | 'received';
  opcode: number;
  data: string;
  at: number;
}

export function retainedNetworkText(text: string, maxChars: number): string {
  // A V8 substring can keep the entire CDP payload alive. Own only the bounded
  // code units, preserving even a lone surrogate at the truncation boundary.
  return Buffer.from(text.slice(0, maxChars), 'utf16le').toString('utf16le');
}

const LEDGER_URL_CHARS = 16_384;
const LEDGER_BODY_CHARS = 64_000;
const LEDGER_HEADER_COUNT = 128;
const LEDGER_HEADER_NAME_CHARS = 256;
const LEDGER_HEADER_VALUE_CHARS = 8_192;
const LEDGER_WEBSOCKET_FRAMES = 100;
const LEDGER_WEBSOCKET_FRAME_CHARS = 16_000;
const LEDGER_WEBSOCKET_TOTAL_CHARS = 256_000;

function headers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, LEDGER_HEADER_COUNT)
      .map(([name, entry]) => [
        retainedNetworkText(name, LEDGER_HEADER_NAME_CHARS),
        retainedNetworkText(String(entry), LEDGER_HEADER_VALUE_CHARS),
      ])
  );
}

/** Header names are case-insensitive, and the two CDP events spell them
 *  differently: the provisional set says "User-Agent", the sent set says
 *  "user-agent". A raw merge would list one header twice and read as if the
 *  request carried it twice, so the sent spelling and value take its place. */
function mergeSentHeaders(provisional: Record<string, string>, sent: Record<string, string>): Record<string, string> {
  const merged = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(provisional)) merged.set(name.toLowerCase(), [name, value]);
  for (const [name, value] of Object.entries(sent)) merged.set(name.toLowerCase(), [name, value]);
  return Object.fromEntries(Array.from(merged.values()).slice(0, LEDGER_HEADER_COUNT));
}

/** A document address as the ledger compares it: the fragment never reaches
 *  the server, so it names the same request. */
function withoutFragment(url: string): string {
  return String(url || '').split('#', 1)[0];
}

function scopedRequestId(sessionId: string | undefined, requestId: string): string {
  return `${sessionId || 'top'}:${requestId}`;
}

function responseData(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export class BrowserNetworkLedger {
  readonly #requests = new Map<string, BrowserNetworkRequest>();
  readonly #inflight = new Map<string, BrowserNetworkRequest>();
  #sequence = 0;

  readonly #maxRequests: number;

  constructor(maxRequests = 250) {
    this.#maxRequests = Math.max(1, Math.trunc(maxRequests) || 250);
  }

  /** The in-flight request a CDP event names, while this ledger still tracks it. */
  #inflightFor(params: Record<string, unknown>, sessionId?: string): BrowserNetworkRequest | undefined {
    return this.#inflight.get(scopedRequestId(sessionId, String(params.requestId || '')));
  }

  requestWillBeSent(
    params: Record<string, unknown>,
    sessionId?: string,
    now = Date.now()
  ): BrowserNetworkRequest | null {
    const cdpRequestId = String(params.requestId || '');
    const request = responseData(params.request);
    if (!cdpRequestId || !request.url) return null;
    const requestUrl = retainedNetworkText(String(request.url), LEDGER_URL_CHARS);
    const scopedId = scopedRequestId(sessionId, cdpRequestId);
    const previous = this.#inflight.get(scopedId);
    const redirect = responseData(params.redirectResponse);
    if (previous && Object.keys(redirect).length > 0) {
      this.#applyResponse(previous, redirect);
      previous.finishedAt = now;
      previous.redirectedTo = requestUrl;
      this.#inflight.delete(scopedId);
    }
    const entry: BrowserNetworkRequest = {
      id: `r${++this.#sequence}`,
      cdpRequestId,
      ...(sessionId ? { sessionId } : {}),
      method: String(request.method || 'GET'),
      url: requestUrl,
      resourceType: String(params.type || 'other').toLowerCase(),
      startedAt: now,
      requestHeaders: headers(request.headers),
      ...(typeof request.postData === 'string'
        ? { requestBody: retainedNetworkText(request.postData, LEDGER_BODY_CHARS) }
        : {}),
      hasPostData: request.hasPostData === true || typeof request.postData === 'string',
      responseHeaders: {},
    };
    this.#requests.set(entry.id, entry);
    this.#inflight.set(scopedId, entry);
    this.#trim();
    return entry;
  }

  /** The headers in requestWillBeSent are provisional: language, encoding,
   *  client hints and cookies are added by the network stack afterwards. A
   *  report built from the provisional set alone reads as if the request never
   *  asked for them, so the sent headers are merged in when they arrive.
   *  Credentials are still named and never shown by the report. */
  requestWillBeSentExtraInfo(params: Record<string, unknown>, sessionId?: string): BrowserNetworkRequest | null {
    const entry = this.#inflightFor(params, sessionId);
    if (!entry) return null;
    entry.requestHeaders = mergeSentHeaders(entry.requestHeaders, headers(params.headers));
    return entry;
  }

  responseReceived(params: Record<string, unknown>, sessionId?: string): BrowserNetworkRequest | null {
    const entry = this.#inflightFor(params, sessionId);
    if (!entry) return null;
    this.#applyResponse(entry, responseData(params.response));
    if (params.type) entry.resourceType = String(params.type).toLowerCase();
    return entry;
  }

  loadingFinished(params: Record<string, unknown>, sessionId?: string, now = Date.now()): BrowserNetworkRequest | null {
    const scopedId = scopedRequestId(sessionId, String(params.requestId || ''));
    const entry = this.#inflight.get(scopedId);
    if (!entry) return null;
    entry.finishedAt = now;
    if (Number.isFinite(Number(params.encodedDataLength))) {
      entry.encodedDataLength = Number(params.encodedDataLength);
    }
    this.#inflight.delete(scopedId);
    return entry;
  }

  loadingFailed(params: Record<string, unknown>, sessionId?: string, now = Date.now()): BrowserNetworkRequest | null {
    const scopedId = scopedRequestId(sessionId, String(params.requestId || ''));
    const entry = this.#inflight.get(scopedId);
    if (!entry) return null;
    entry.finishedAt = now;
    entry.failure = String(params.errorText || 'failed');
    entry.canceled = params.canceled === true;
    this.#inflight.delete(scopedId);
    return entry;
  }

  finishDocument(url: string, now = Date.now()): number {
    const normalizedUrl = withoutFragment(url);
    let finished = 0;
    for (const [scopedId, entry] of this.#inflight) {
      if (entry.resourceType !== 'document' || withoutFragment(entry.url) !== normalizedUrl) continue;
      entry.finishedAt = now;
      this.#inflight.delete(scopedId);
      finished += 1;
    }
    return finished;
  }

  webSocketCreated(
    params: Record<string, unknown>,
    sessionId?: string,
    now = Date.now()
  ): BrowserNetworkRequest | null {
    const cdpRequestId = String(params.requestId || '');
    if (!cdpRequestId) return null;
    const scopedId = scopedRequestId(sessionId, cdpRequestId);
    const existing = this.#inflight.get(scopedId);
    if (existing) {
      existing.resourceType = 'websocket';
      return existing;
    }
    return this.requestWillBeSent(
      {
        requestId: cdpRequestId,
        type: 'websocket',
        request: {
          method: 'GET',
          url: String(params.url || ''),
          headers: {},
        },
      },
      sessionId,
      now
    );
  }

  /** The upgrade request a socket actually sent. `webSocketCreated` carries the
   *  address alone, so without this a WebSocket detail shows no request headers
   *  at all — and a refused upgrade is usually explained by one of them. */
  webSocketWillSendHandshakeRequest(params: Record<string, unknown>, sessionId?: string): BrowserNetworkRequest | null {
    const entry = this.#inflightFor(params, sessionId);
    if (!entry) return null;
    entry.requestHeaders = mergeSentHeaders(entry.requestHeaders, headers(responseData(params.request).headers));
    return entry;
  }

  webSocketHandshakeResponse(params: Record<string, unknown>, sessionId?: string): BrowserNetworkRequest | null {
    const entry = this.#inflightFor(params, sessionId);
    if (!entry) return null;
    this.#applyResponse(entry, responseData(params.response));
    entry.resourceType = 'websocket';
    return entry;
  }

  webSocketFrame(
    params: Record<string, unknown>,
    direction: BrowserWebSocketFrame['direction'],
    sessionId?: string,
    now = Date.now()
  ): BrowserNetworkRequest | null {
    const entry = this.#inflightFor(params, sessionId);
    if (!entry) return null;
    const frame = responseData(params.response);
    const frames = entry.webSocketFrames || [];
    frames.push({
      direction,
      opcode: Number(frame.opcode) || 0,
      data: retainedNetworkText(String(frame.payloadData || ''), LEDGER_WEBSOCKET_FRAME_CHARS),
      at: now,
    });
    let totalChars = frames.reduce((total, item) => total + item.data.length, 0);
    while (frames.length > LEDGER_WEBSOCKET_FRAMES || totalChars > LEDGER_WEBSOCKET_TOTAL_CHARS) {
      totalChars -= frames.shift()?.data.length || 0;
    }
    entry.webSocketFrames = frames;
    return entry;
  }

  webSocketClosed(params: Record<string, unknown>, sessionId?: string, now = Date.now()): BrowserNetworkRequest | null {
    return this.loadingFinished(params, sessionId, now);
  }

  /** The HTTP answer behind the document at `url`: the newest document
   *  request for that address, so a 404 page reads as one. */
  documentStatus(url: string): { status: number; statusText?: string; mimeType?: string } | null {
    const wanted = withoutFragment(url);
    if (!wanted) return null;
    const requests = [...this.#requests.values()];
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const request = requests[index];
      if (request.resourceType !== 'document' || request.status === undefined) continue;
      if (withoutFragment(request.url) !== wanted) continue;
      return { status: request.status, statusText: request.statusText, mimeType: request.mimeType };
    }
    return null;
  }

  get(id: string): BrowserNetworkRequest | undefined {
    return this.#requests.get(id);
  }

  inflightResourceType(cdpRequestId: string, sessionId?: string): string | undefined {
    return this.#inflight.get(scopedRequestId(sessionId, cdpRequestId))?.resourceType;
  }

  list(options: { query?: string; resourceTypes?: string[]; limit?: number } = {}): {
    requests: BrowserNetworkRequest[];
    total: number;
  } {
    const query = String(options.query || '')
      .trim()
      .toLowerCase();
    const types = new Set((options.resourceTypes || []).map((type) => type.toLowerCase()));
    const matched = [...this.#requests.values()]
      .filter((request) => {
        if (types.size && !types.has(request.resourceType)) return false;
        if (!query) return true;
        const status = request.failure || request.status || (request.finishedAt ? 'finished' : 'pending');
        return [request.id, request.method, request.url, request.resourceType, request.mimeType, status].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(query)
        );
      })
      .reverse();
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit || 50)));
    return { requests: matched.slice(0, limit), total: matched.length };
  }

  recentInflight(now = Date.now(), maxAgeMs = 15_000): BrowserNetworkRequest[] {
    return [...this.#inflight.values()].filter((request) => now - request.startedAt < maxAgeMs);
  }

  get pendingCount(): number {
    return this.#inflight.size;
  }

  #applyResponse(entry: BrowserNetworkRequest, response: Record<string, unknown>): void {
    if (Number.isFinite(Number(response.status))) entry.status = Number(response.status);
    if (response.statusText !== undefined) entry.statusText = String(response.statusText);
    entry.responseHeaders = headers(response.headers);
    if (response.mimeType !== undefined) entry.mimeType = String(response.mimeType);
    if (response.protocol !== undefined) entry.protocol = String(response.protocol);
    if (response.remoteIPAddress) {
      const port = Number(response.remotePort);
      entry.remoteAddress = `${String(response.remoteIPAddress)}${Number.isFinite(port) && port > 0 ? `:${port}` : ''}`;
    }
    entry.fromDiskCache = response.fromDiskCache === true;
    entry.fromServiceWorker = response.fromServiceWorker === true;
  }

  #trim(): void {
    while (this.#requests.size > this.#maxRequests) {
      const removable =
        [...this.#requests.entries()].find(([, request]) => request.finishedAt !== undefined) ||
        this.#requests.entries().next().value;
      if (!removable) return;
      this.#requests.delete(removable[0]);
      for (const [scopedId, request] of this.#inflight) {
        if (request === removable[1]) this.#inflight.delete(scopedId);
      }
    }
  }
}
