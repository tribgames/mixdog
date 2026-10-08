import {
  normalizeDesktopFeedback,
  type DesktopFeedbackReceipt,
} from '../shared/contract-feedback';
import { resolveRelayUrl } from './remote-relay-device';

/** The renderer cannot select a recipient, URL, SMTP account or credentials. */
export async function submitFeedback(
  value: unknown,
  { env = process.env, request = fetch }: { env?: NodeJS.ProcessEnv; request?: typeof fetch } = {}
): Promise<DesktopFeedbackReceipt> {
  const input = normalizeDesktopFeedback(value);
  const relay = resolveRelayUrl(env);
  if (!relay) throw new Error('Feedback service is unavailable.');
  const url = new URL(relay);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/feedback';
  url.search = '';
  url.hash = '';
  let response: Response;
  try {
    response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(input.attachments ? 60_000 : 15_000),
    });
  } catch {
    throw new Error('Unable to submit feedback. Please try again.');
  }
  if (response.status === 429) throw new Error('Too many feedback requests. Please try again later.');
  if (response.status !== 202) throw new Error('Feedback service is unavailable. Please try again later.');
  let receipt: Partial<DesktopFeedbackReceipt> | null;
  try {
    receipt = (await response.json()) as Partial<DesktopFeedbackReceipt> | null;
  } catch {
    throw new Error('Feedback receipt is invalid. Please try again.');
  }
  if (receipt?.id !== input.id || receipt?.status !== 'accepted') {
    throw new Error('Feedback receipt is invalid. Please try again.');
  }
  return { id: input.id, status: 'accepted' };
}
