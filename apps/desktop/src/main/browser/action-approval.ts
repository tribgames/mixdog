/** One-shot, target-bound approvals. No page text or agent-supplied boolean
 * can mint a grant. Optional policies name public actions, not site heuristics. */
import { BROWSER_ACTIONS } from '../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import type { BrowserCommand } from './command';
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

export function createBrowserActionApproval(host: {
  ask(request: BrowserApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  confirmActions?: string;
  denyActions?: string;
  now?: () => number;
}) {
  const now = host.now || Date.now;
  function actions(raw = '') {
    const names = raw.split(',').map((name) => name.trim()).filter(Boolean);
    if (names.some((name) => name !== '*' && !BROWSER_ACTIONS.includes(name))) {
      throw new Error('invalid Browser Use action policy; refusing dispatch');
    }
    return new Set(names);
  }
  async function approve(
    command: BrowserCommand,
    target: () => { url: string; identity: string },
    signal?: AbortSignal,
  ) {
    const denied = actions(host.denyActions);
    const confirmation = actions(host.confirmActions);
    const names = [command.action, ...(command.steps || []).map((step) => step.action || '')];
    if (denied.has('*') || names.some((name) => denied.has(name))) {
      throw new Error('Browser Use action is denied by policy; nothing was dispatched');
    }
    const sharedClear = String(command.operation).toLowerCase() === 'clear'
      && (command.action === 'cookies' || (command.action === 'storage' && String(command.storageType).toLowerCase() !== 'session'));
    if (command.action !== 'upload' && !sharedClear
      && !confirmation.has('*') && !names.some((name) => confirmation.has(name))) return;
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    if (command.action === 'upload') {
      if (!command.paths?.length || command.paths.length > 10) throw new Error('upload requires 1–10 approved absolute file paths');
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
    const allowed = await host.ask({
      action: command.action, url: original.url, sessionId: command.session_id || '',
      target: command.ref || command.snapshotId || command.name || original.identity,
      paths: command.paths || [], expiresAt,
    }, signal);
    if (signal?.aborted) throw signal.reason || new Error('approval cancelled');
    const current = target();
    if (!allowed || now() >= expiresAt || current.identity !== original.identity
      || current.url !== original.url || JSON.stringify(command) !== serialized) {
      throw new Error('Browser Use approval denied, expired, or target changed; nothing was dispatched');
    }
    for (const file of files) {
      const info = await stat(file.path);
      if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
        throw new Error('approved upload file changed; nothing was dispatched');
      }
    }
    if (signal?.aborted || now() >= expiresAt || target().identity !== original.identity
      || target().url !== original.url) throw new Error('approval expired or target changed before dispatch');
    // A grant exists only on this stack: it cannot be reused by another call.
  }
  return { approve };
}
