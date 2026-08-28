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

export interface BrowserWebSocketFrame {
  direction: 'sent' | 'received';
  opcode: number;
  data: string;
  at: number;
}

function headers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([name, entry]) => [name, String(entry)]),
  );
}

function scopedRequestId(sessionId: string | undefined, requestId: string): string {
  return `${sessionId || 'top'}:${requestId}`;
}

function responseData(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

export class BrowserNetworkLedger {
  readonly #requests = new Map<string, BrowserNetworkRequest>();
  readonly #inflight = new Map<string, BrowserNetworkRequest>();
  #sequence = 0;

  constructor(private readonly maxRequests = 250) {}

  requestWillBeSent(
    params: Record<string, unknown>,
    sessionId?: string,
    now = Date.now(),
  ): BrowserNetworkRequest | null {
    const cdpRequestId = String(params.requestId || '');
    const request = responseData(params.request);
    if (!cdpRequestId || !request.url) return null;
    const scopedId = scopedRequestId(sessionId, cdpRequestId);
    const previous = this.#inflight.get(scopedId);
    const redirect = responseData(params.redirectResponse);
    if (previous && Object.keys(redirect).length > 0) {
      this.#applyResponse(previous, redirect);
      previous.finishedAt = now;
      previous.redirectedTo = String(request.url);
      this.#inflight.delete(scopedId);
    }
    const entry: BrowserNetworkRequest = {
      id: `r${++this.#sequence}`,
      cdpRequestId,
      ...(sessionId ? { sessionId } : {}),
      method: String(request.method || 'GET'),
      url: String(request.url),
      resourceType: String(params.type || 'other').toLowerCase(),
      startedAt: now,
      requestHeaders: headers(request.headers),
      ...(typeof request.postData === 'string' ? { requestBody: request.postData } : {}),
      hasPostData: request.hasPostData === true || typeof request.postData === 'string',
      responseHeaders: {},
    };
    this.#requests.set(entry.id, entry);
    this.#inflight.set(scopedId, entry);
    this.#trim();
    return entry;
  }

  responseReceived(
    params: Record<string, unknown>,
    sessionId?: string,
  ): BrowserNetworkRequest | null {
    const entry = this.#inflight.get(scopedRequestId(
      sessionId,
      String(params.requestId || ''),
    ));
    if (!entry) return null;
    this.#applyResponse(entry, responseData(params.response));
    if (params.type) entry.resourceType = String(params.type).toLowerCase();
    return entry;
  }

  loadingFinished(
    params: Record<string, unknown>,
    sessionId?: string,
    now = Date.now(),
  ): BrowserNetworkRequest | null {
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

  loadingFailed(
    params: Record<string, unknown>,
    sessionId?: string,
    now = Date.now(),
  ): BrowserNetworkRequest | null {
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
    const normalizedUrl = String(url || '').split('#', 1)[0];
    let finished = 0;
    for (const [scopedId, entry] of this.#inflight) {
      if (entry.resourceType !== 'document'
        || String(entry.url || '').split('#', 1)[0] !== normalizedUrl) continue;
      entry.finishedAt = now;
      this.#inflight.delete(scopedId);
      finished += 1;
    }
    return finished;
  }

  webSocketCreated(
    params: Record<string, unknown>,
    sessionId?: string,
    now = Date.now(),
  ): BrowserNetworkRequest | null {
    const cdpRequestId = String(params.requestId || '');
    if (!cdpRequestId) return null;
    const scopedId = scopedRequestId(sessionId, cdpRequestId);
    const existing = this.#inflight.get(scopedId);
    if (existing) {
      existing.resourceType = 'websocket';
      return existing;
    }
    return this.requestWillBeSent({
      requestId: cdpRequestId,
      type: 'websocket',
      request: {
        method: 'GET',
        url: String(params.url || ''),
        headers: {},
      },
    }, sessionId, now);
  }

  webSocketHandshakeResponse(
    params: Record<string, unknown>,
    sessionId?: string,
  ): BrowserNetworkRequest | null {
    const entry = this.#inflight.get(scopedRequestId(
      sessionId,
      String(params.requestId || ''),
    ));
    if (!entry) return null;
    this.#applyResponse(entry, responseData(params.response));
    entry.resourceType = 'websocket';
    return entry;
  }

  webSocketFrame(
    params: Record<string, unknown>,
    direction: BrowserWebSocketFrame['direction'],
    sessionId?: string,
    now = Date.now(),
  ): BrowserNetworkRequest | null {
    const entry = this.#inflight.get(scopedRequestId(
      sessionId,
      String(params.requestId || ''),
    ));
    if (!entry) return null;
    const frame = responseData(params.response);
    const frames = entry.webSocketFrames || [];
    frames.push({
      direction,
      opcode: Number(frame.opcode) || 0,
      data: String(frame.payloadData || ''),
      at: now,
    });
    if (frames.length > 500) frames.splice(0, frames.length - 500);
    entry.webSocketFrames = frames;
    return entry;
  }

  webSocketClosed(
    params: Record<string, unknown>,
    sessionId?: string,
    now = Date.now(),
  ): BrowserNetworkRequest | null {
    return this.loadingFinished(params, sessionId, now);
  }

  get(id: string): BrowserNetworkRequest | undefined {
    return this.#requests.get(id);
  }

  list(options: {
    query?: string;
    resourceTypes?: string[];
    limit?: number;
  } = {}): { requests: BrowserNetworkRequest[]; total: number } {
    const query = String(options.query || '').trim().toLowerCase();
    const types = new Set((options.resourceTypes || []).map((type) => type.toLowerCase()));
    const matched = [...this.#requests.values()].filter((request) => {
      if (types.size && !types.has(request.resourceType)) return false;
      if (!query) return true;
      const status = request.failure || request.status || (request.finishedAt ? 'finished' : 'pending');
      return [
        request.id,
        request.method,
        request.url,
        request.resourceType,
        request.mimeType,
        status,
      ].some((value) => String(value || '').toLowerCase().includes(query));
    }).reverse();
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit || 50)));
    return { requests: matched.slice(0, limit), total: matched.length };
  }

  recentInflight(now = Date.now(), maxAgeMs = 15_000): BrowserNetworkRequest[] {
    return [...this.#inflight.values()]
      .filter((request) => now - request.startedAt < maxAgeMs);
  }

  get pendingCount(): number {
    return this.#inflight.size;
  }

  #applyResponse(
    entry: BrowserNetworkRequest,
    response: Record<string, unknown>,
  ): void {
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
    while (this.#requests.size > this.maxRequests) {
      const removable = [...this.#requests.entries()]
        .find(([, request]) => request.finishedAt !== undefined);
      if (!removable) return;
      this.#requests.delete(removable[0]);
    }
  }
}
