// Settings → Git auto commit message: build a bounded diff for the included
// files and ask the runtime's maintenance model (the session-title route) for
// one commit message. Pure request/response — git is never touched from here;
// the regular commit pipeline commits whatever the user ends up with.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DesktopGitPreferences } from '../shared/contract';
import { gitDiff } from './git-cli';

interface CommitCompletionModule {
  generateCommitMessage(source: string, options?: { style?: string }): Promise<string>;
}

export interface CommitMessageFileInput {
  path: string;
  untracked?: boolean;
}

/** Same runtime layout the settings store uses for config.mjs. */
export function commitCompletionModuleUrl(
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd(),
): string {
  const modulePath = packaged
    ? join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src', 'runtime',
      'agent', 'orchestrator', 'agent-runtime', 'commit-message-completion.mjs')
    : resolve(appPath, '../../src/runtime/agent/orchestrator/agent-runtime/commit-message-completion.mjs');
  return pathToFileURL(modulePath).href;
}

// Keeps the maintenance-route prompt affordable (ORCA budgets ~200KB).
const DIFF_TOTAL_BUDGET = 160_000;

function commitStyleHint(preferences: DesktopGitPreferences | null): string {
  if (preferences?.commitPreset === 'conventional') {
    return 'Format the first line as Conventional Commits — type(scope): subject — using feat|fix|docs|style|refactor|perf|test|build|ci|chore.';
  }
  if (preferences?.commitPreset === 'custom' && preferences.commitTemplate.trim()) {
    return `Follow this commit message pattern:\n${preferences.commitTemplate.trim()}`;
  }
  return '';
}

export function createCommitMessageGenerator({
  packaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd(),
  loadModule,
  diffFor = gitDiff,
}: {
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  loadModule?: () => Promise<CommitCompletionModule>;
  diffFor?: typeof gitDiff;
} = {}) {
  let modulePromise: Promise<CommitCompletionModule> | null = null;
  const load = loadModule ?? (() => (modulePromise ??= import(
    /* @vite-ignore */ commitCompletionModuleUrl(packaged, resourcesPath, appPath)
  ) as Promise<CommitCompletionModule>));
  return async function generateCommitMessage(
    cwd: string,
    files: CommitMessageFileInput[],
    preferences: DesktopGitPreferences | null,
  ): Promise<string> {
    const sections: string[] = [];
    // Every file gets a fair slice so one huge diff cannot starve the rest
    // (ORCA's water-filling allocator, simplified to an even split).
    const perFile = Math.max(4_000, Math.floor(DIFF_TOTAL_BUDGET / Math.max(1, files.length)));
    let used = 0;
    for (const file of files) {
      if (used >= DIFF_TOTAL_BUDGET) {
        sections.push(`# ${file.path} (omitted: diff budget exhausted)`);
        continue;
      }
      const diff = await diffFor(cwd, file.path, false, false, file.untracked === true)
        .catch(() => '');
      if (!diff.trim()) {
        // Binary/renamed-only entries still deserve a mention in the prompt.
        sections.push(`# ${file.path} (no textual diff)`);
        continue;
      }
      const clipped = diff.length > perFile
        ? `${diff.slice(0, perFile)}\n...(truncated ${diff.length - perFile} chars)`
        : diff;
      used += clipped.length;
      sections.push(clipped);
    }
    const source = sections.join('\n').trim();
    if (!source) throw new Error('The selected files have no diff to describe.');
    const completion = await load();
    const message = (await completion.generateCommitMessage(source, {
      style: commitStyleHint(preferences),
    })).trim();
    if (!message) throw new Error('Commit message generation returned nothing.');
    return message;
  };
}
