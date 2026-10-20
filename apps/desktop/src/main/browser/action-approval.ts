/** One-shot, target-bound approvals. Submitting and posting ask by default: a
 * command that submits a form (`submit`, Enter) or clicks a target named as a
 * send/post control. MIXDOG_BROWSER_CONFIRM_ACTIONS names more actions to
 * confirm; MIXDOG_BROWSER_CONFIRM_SUBMIT=0 turns the default off (automation
 * harnesses). Each approval is a human confirmation that no page text or
 * agent-supplied field can mint. */
import { BROWSER_ACTIONS } from '../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import type { BrowserCommand } from './command';
import { describeBrowserTarget } from './target-resolve';
import { redactBrowserText } from './redaction';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface BrowserApprovalRequest {
  action: string;
  url: string;
  sessionId: string;
  target: string;
  paths: string[];
  expiresAt: number;
}

/** Describe only actions and addresses, never form values or typed secrets. */
function describeApprovalTargets(command: BrowserCommand, fallback: string): string {
  const describe = (input: Pick<BrowserCommand, 'target' | 'ref' | 'snapshotId' | 'name'>) =>
    input.target
      ? describeBrowserTarget(input.target)
      : redactBrowserText(input.ref || input.snapshotId || input.name || fallback);
  let summary = describe(command);
  if (command.action === 'sequence' && command.steps?.length) {
    summary = command.steps
      .map(
        (step, index) =>
          `${index + 1}. ${redactBrowserText(step.action)}${step.submit ? ' (submit)' : ''}: ${describe(step)}`
      )
      .join('\n');
  } else if (command.action === 'fill' && command.fields?.length) {
    summary = command.fields.map((field, index) => `${index + 1}. fill: ${describe(field)}`).join('\n');
  }
  return command.submit ? `${summary}\nSubmit form` : summary;
}

/** Accessible names of controls that send or post (word match, any case). */
const POST_CONTROL_NAME = /\b(?:submit|send|post|publish|tweet|reply|comment)\b/i;

type ApprovalStep = Pick<BrowserCommand, 'action' | 'submit' | 'key' | 'target'>;

function stepSubmits(step: ApprovalStep): boolean {
  if (step.submit === true) return true;
  if (step.action === 'press' && String(step.key || '').toLowerCase() === 'enter') return true;
  return step.action === 'click' && POST_CONTROL_NAME.test(String(step.target?.name || ''));
}

/** Whether a command submits a form or posts: confirmed by default. */
export function browserCommandSubmits(command: BrowserCommand): boolean {
  return stepSubmits(command) || (command.steps || []).some((step) => stepSubmits(step as ApprovalStep));
}

export function createBrowserActionApproval(host: {
  ask(request: BrowserApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  confirmActions?: string;
  denyActions?: string;
  /** Default true: submits and posts ask (see browserCommandSubmits). */
  confirmSubmit?: boolean;
  now?: () => number;
}) {
  const now = host.now || Date.now;
  function actions(raw = '') {
    const names = raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.some((name) => name !== '*' && !BROWSER_ACTIONS.includes(name))) {
      throw new Error('invalid Browser Use action policy; refusing dispatch');
    }
    return new Set(names);
  }
  async function approve(
    command: BrowserCommand,
    target: () => { url: string; identity: string },
    signal?: AbortSignal
  ) {
    const denied = actions(host.denyActions);
    const confirmation = actions(host.confirmActions);
    const names = [command.action, ...(command.steps || []).map((step) => step.action || '')];
    if (denied.has('*') || names.some((name) => denied.has(name))) {
      throw new Error('Browser Use action is denied by policy; nothing was dispatched');
    }
    const submits = host.confirmSubmit !== false && browserCommandSubmits(command);
    if (!submits && !confirmation.has('*') && !names.some((name) => confirmation.has(name))) return;
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    if (command.action === 'upload') {
      if (!command.paths?.length || command.paths.length > 10)
        throw new Error('upload requires 1–10 approved absolute file paths');
      for (const path of command.paths) {
        if (!isAbsolute(path)) throw new Error('upload approval requires absolute file paths');
        const canonical = await realpath(path);
        const info = await stat(canonical);
        if (!info.isFile()) throw new Error('upload approval requires regular files');
        files.push({ path: canonical, size: info.size, mtimeMs: info.mtimeMs });
      }
      command.paths = files.map((file) => file.path);
    }
    const original = target();
    const serialized = JSON.stringify(command);
    const expiresAt = now() + 30_000;
    if (signal?.aborted) throw signal.reason || new Error('approval cancelled');
    const allowed = await host.ask(
      {
        action: command.action,
        url: original.url,
        sessionId: command.session_id || '',
        target: describeApprovalTargets(command, original.identity),
        paths: command.paths || [],
        expiresAt,
      },
      signal
    );
    if (signal?.aborted) throw signal.reason || new Error('approval cancelled');
    const current = target();
    if (
      !allowed ||
      now() >= expiresAt ||
      current.identity !== original.identity ||
      current.url !== original.url ||
      JSON.stringify(command) !== serialized
    ) {
      throw new Error('Browser Use approval denied, expired, or target changed; nothing was dispatched');
    }
    for (const file of files) {
      const info = await stat(file.path);
      if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        throw new Error('approved upload file changed; nothing was dispatched');
      }
    }
    if (
      signal?.aborted ||
      now() >= expiresAt ||
      target().identity !== original.identity ||
      target().url !== original.url
    )
      throw new Error('approval expired or target changed before dispatch');
    // A grant exists only on this stack: it cannot be reused by another call.
  }
  return { approve };
}
