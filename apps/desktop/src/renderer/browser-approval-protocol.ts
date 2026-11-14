// The browser approval card as the core asks for it: `item/browser/requestApproval` arrives on the protocol client as a
// server request, the card's answer goes back as a `ToolApprovalDecision`, and the core resolving the request elsewhere
// (`serverRequest/resolved`) closes the card.
import type { ProtocolClient } from '../../../../packages/protocol-client/src/index.ts';
import type { ToolApprovalDecision } from '../../../../packages/protocol/src/index';
import type { BrowserApprovalPrompt } from './BrowserApprovalHost';

export type BrowserApprovalChoice = 'once' | 'session' | 'always' | 'deny';

/** The decision a card choice stands for. A deny carries the reason typed on the card, when there is one. */
export function browserApprovalDecision(choice: BrowserApprovalChoice, reason?: string): ToolApprovalDecision {
  if (choice === 'deny') return { approved: false, ...(reason ? { reason } : {}) };
  return { approved: true, remember: choice };
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function normalizeFiles(value: unknown): BrowserApprovalPrompt['files'] {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isObj).map((file) => ({
    name: text(file.name),
    path: text(file.path),
    size: typeof file.size === 'number' ? file.size : 0,
    outside: file.outside === true,
  }));
}

/** The card's prompt from a request: the core's `request` carries the card fields; the envelope fills the ids it leaves out. */
export function browserApprovalPrompt(
  requestId: string,
  params: { action: string; request: unknown; threadId: string; surfaceThreadId?: string | null }
): BrowserApprovalPrompt {
  const card: Obj = isObj(params.request) ? params.request : {};
  const remember = isObj(card.remember) ? { kinds: strings(card.remember.kinds), ...(card.remember.session === true ? { session: true } : {}) } : null;
  const files = normalizeFiles(card.files);
  const surface = text(card.surfaceSessionId) || params.surfaceThreadId || undefined;
  return {
    id: requestId,
    action: text(card.action) || params.action,
    url: text(card.url),
    sessionId: text(card.sessionId) || params.threadId,
    ...(surface ? { surfaceSessionId: surface } : {}),
    ...(text(card.agentId) ? { agentId: text(card.agentId) } : {}),
    requester: text(card.requester),
    target: text(card.target),
    paths: strings(card.paths),
    ...(text(card.origin) ? { origin: text(card.origin) } : {}),
    ...(text(card.receiverOrigin) ? { receiverOrigin: text(card.receiverOrigin) } : {}),
    ...(files ? { files } : {}),
    remember,
    ...(card.payment === true ? { payment: true } : {}),
  };
}

/** Answers the card; false when the answer could not leave (the card stays and the core offers it again after a reconnect). */
export type BrowserApprovalAnswer = (choice: BrowserApprovalChoice, reason?: string) => boolean;

/** Calls `onPrompt` for every browser approval the core offers (the ones already held included) and `onResolved(promptId)`
 *  when the core resolved one elsewhere. Returns the stop function. */
export function subscribeBrowserApprovals(
  client: Pick<ProtocolClient, 'on' | 'pendingServerRequests' | 'respond'>,
  onPrompt: (prompt: BrowserApprovalPrompt, answer: BrowserApprovalAnswer) => void,
  onResolved: (promptId: string) => void = () => undefined
): () => void {
  const prompts = new Map<string, string>();
  const offer = (request: { id: unknown; method: string; params: unknown }): void => {
    if (request.method !== 'item/browser/requestApproval' || !isObj(request.params)) return;
    const params = request.params as { action?: unknown; request?: unknown; threadId?: unknown; surfaceThreadId?: unknown };
    const requestId = String(request.id);
    const prompt = browserApprovalPrompt(requestId, {
      action: text(params.action),
      request: params.request,
      threadId: text(params.threadId),
      surfaceThreadId: text(params.surfaceThreadId) || undefined,
    });
    prompts.set(requestId, prompt.id);
    onPrompt(prompt, (choice, reason) => {
      try {
        client.respond(request.id as never, { result: browserApprovalDecision(choice, reason) as never });
        return true;
      } catch (error) {
        console.error('browser approval answer did not leave', error);
        return false;
      }
    });
  };
  for (const request of client.pendingServerRequests()) offer(request);
  const stop = client.on((event) => {
    if (event.type === 'serverRequest') offer(event.request);
    else if (event.type === 'serverRequestResolved') {
      const promptId = prompts.get(String(event.params.requestId));
      if (promptId === undefined) return;
      prompts.delete(String(event.params.requestId));
      onResolved(promptId);
    }
  });
  return () => {
    stop();
    for (const promptId of prompts.values()) onResolved(promptId);
    prompts.clear();
  };
}
