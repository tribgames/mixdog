/** One-shot, target-bound approvals. Submitting, posting and uploading files
 * ask by default: a command that submits a form (`submit`, Enter), clicks a
 * target named as a send/post control, or is an `upload`.
 * MIXDOG_BROWSER_CONFIRM_ACTIONS names more actions to confirm;
 * MIXDOG_BROWSER_CONFIRM_SUBMIT=0 turns all of these defaults off (automation
 * harnesses). Each approval is a human confirmation that no page text or
 * agent-supplied field can mint.
 *
 * An approval waits until the person answers: only Deny, a cancelled command or
 * a closing window settle it sooner. Nothing about the time spent waiting makes
 * the answer stale; what does is the page — the document, its URL, the command
 * and (for an upload) the files and the receiving frame must be the ones that
 * were shown, or nothing is dispatched. */
import { BROWSER_ACTIONS } from '../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import type { BrowserCommand } from './command';
import { describeBrowserTarget } from './target-resolve';
import { redactBrowserText } from './redaction';
import type { UserWait } from './user-wait';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Why a command asks. `submit` (form submit / Enter), `post` (a click on a
 *  send or post control) and `upload` (files handed to the page) are features
 *  a bot may be given a standing allow for; `confirm` is an action the operator
 *  named in MIXDOG_BROWSER_CONFIRM_ACTIONS, which always asks. */
export type BrowserApprovalKind = 'submit' | 'post' | 'upload' | 'confirm';

export interface BrowserApprovalRequest {
  action: string;
  url: string;
  sessionId: string;
  target: string;
  paths: string[];
  kinds: BrowserApprovalKind[];
  /** An upload's real files (name and size are read from the path). */
  files?: Array<{ path: string; size: number }>;
  /** The origin of the frame document that receives an upload's files, as
   *  resolved from the target before asking; '' when it could not be confirmed
   *  (no tuple origin, or no way to resolve it). */
  receiverOrigin?: string;
  /** The command belongs to a schedule or webhook run (runtime-set): its saved
   *  routine granted submits, posts and uploads, so only a bot's `block` or an
   *  operator `confirm` applies (approval-dialog.ts). */
  unattended?: boolean;
  /** The bot that owns that run, from the run's own record (runtime-set, never
   *  display metadata); '' when it could not be established — the run is then
   *  refused (approval-dialog.ts). */
  unattendedAgent?: string;
}

/** Where an upload's files would land: `key` is bound by the approval,
 *  `url` is the receiving frame document (see ref-upload.ts `receiver`). */
export interface UploadReceiverBinding {
  key: string;
  url: string;
}

/** What the agent is told when a person did not approve a step: the wording of
 *  every tool denial (loop/tool-helpers.mjs), with the person's note as the
 *  reason when they gave one. */
export function browserNotApproved(reason = ''): string {
  const why = reason.trim().replace(/[.\s]+$/, '');
  return `tool "browser" was not approved${why ? `: ${why}` : ''}. Do not retry it or reach the same result another way; report it.`;
}

const TARGET_CHANGED = 'Browser Use approval target changed; nothing was dispatched';

/** `scheme://host[:port]` of a URL; '' when it has no tuple origin. */
export function originOfUrl(url: string): string {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
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

function stepKind(step: ApprovalStep): 'submit' | 'post' | null {
  if (step.submit === true) return 'submit';
  if (step.action === 'press' && String(step.key || '').toLowerCase() === 'enter') return 'submit';
  return step.action === 'click' && POST_CONTROL_NAME.test(String(step.target?.name || '')) ? 'post' : null;
}

function stepSubmits(step: ApprovalStep): boolean {
  return stepKind(step) !== null;
}

/** Every kind of gated step the command holds (`submit`, `post`). */
function submitKinds(command: BrowserCommand): Array<'submit' | 'post'> {
  const kinds = new Set<'submit' | 'post'>();
  for (const step of [command, ...(command.steps || [])]) {
    const kind = stepKind(step as ApprovalStep);
    if (kind) kinds.add(kind);
  }
  return [...kinds];
}

/** Whether a command submits a form or posts: confirmed by default. */
export function browserCommandSubmits(command: BrowserCommand): boolean {
  return stepSubmits(command) || (command.steps || []).some((step) => stepSubmits(step as ApprovalStep));
}

export function createBrowserActionApproval(host: {
  ask(request: BrowserApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  confirmActions?: string;
  denyActions?: string;
  /** Default true: submits, posts and uploads ask (see browserCommandSubmits). */
  confirmSubmit?: boolean;
}) {
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
    signal?: AbortSignal,
    /** Upload only: resolves the target (a `target` spec becomes a `ref` on the
     *  command) and the frame document that would receive the files. Called
     *  before asking and again before returning, so the approval is bound to
     *  the real receiving frame, not just the top page. */
    uploadReceiver?: () => Promise<UploadReceiverBinding>,
    /** The command's clock: it stands still while the person is asked, so
     *  the time they take is not the page's slowness. */
    userWait?: UserWait
  ): Promise<{ receiver?: string }> {
    const denied = actions(host.denyActions);
    const confirmation = actions(host.confirmActions);
    const names = [command.action, ...(command.steps || []).map((step) => step.action || '')];
    if (denied.has('*') || names.some((name) => denied.has(name))) {
      throw new Error('Browser Use action is denied by policy; nothing was dispatched');
    }
    const submits = host.confirmSubmit !== false && browserCommandSubmits(command);
    const confirmed = confirmation.has('*') || names.some((name) => confirmation.has(name));
    const isUpload = command.action === 'upload';
    const uploads = host.confirmSubmit !== false && isUpload;
    if (!submits && !uploads && !confirmed) return {};
    const kinds: BrowserApprovalKind[] = submits ? submitKinds(command) : [];
    if (uploads) kinds.push('upload');
    if (confirmed) kinds.push('confirm');
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    if (isUpload) {
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
    const receiver = isUpload ? await uploadReceiver?.() : undefined;
    const original = target();
    const serialized = JSON.stringify(command);
    if (signal?.aborted) throw signal.reason || new Error('approval cancelled');
    const releaseWait = userWait?.begin();
    let allowed: boolean;
    try {
      allowed = await host.ask(
        {
          action: command.action,
          url: original.url,
          sessionId: command.session_id || '',
          target: describeApprovalTargets(command, original.identity),
          paths: command.paths || [],
          kinds,
          ...(command.unattended_run === true
            ? { unattended: true, unattendedAgent: String(command.unattended_agent || '').trim() }
            : {}),
          ...(files.length
            ? {
                files: files.map(({ path, size }) => ({ path, size })),
                receiverOrigin: originOfUrl(receiver?.url || ''),
              }
            : {}),
        },
        signal
      );
    } finally {
      releaseWait?.();
    }
    if (signal?.aborted) throw signal.reason || new Error('approval cancelled');
    const current = target();
    if (!allowed) throw new Error(browserNotApproved());
    if (
      current.identity !== original.identity ||
      current.url !== original.url ||
      JSON.stringify(command) !== serialized
    ) {
      throw new Error(TARGET_CHANGED);
    }
    for (const file of files) {
      const info = await stat(file.path);
      if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        throw new Error('approved upload file changed; nothing was dispatched');
      }
    }
    if (signal?.aborted || target().identity !== original.identity || target().url !== original.url)
      throw new Error('approval target changed before dispatch');
    if (receiver && (await uploadReceiver?.())?.key !== receiver.key) {
      throw new Error(TARGET_CHANGED);
    }
    // A grant exists only on this stack: it cannot be reused by another call.
    // The upload handler checks `receiver` once more right before the files move.
    return { receiver: receiver?.key };
  }
  return { approve };
}
