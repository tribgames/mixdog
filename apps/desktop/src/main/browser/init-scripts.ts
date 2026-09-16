/**
 * Scripts registered to run at the start of every navigation on a page.
 *
 * This is the one moment `evaluate` can never reach: an evaluated script always
 * arrives after the document has already booted, so anything a page reads
 * during startup — a feature flag, a stubbed clock, a seeded token — has to be
 * installed before that navigation begins rather than repaired afterwards.
 */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { BrowserCommand, BrowserCommandResult } from './command';

const MAX_SCRIPTS_PER_PAGE = 10;
const MAX_SCRIPT_CHARS = 20_000;

interface RegisteredInitScript {
  id: string;
  /** Chromium's own handle, needed to remove the script again. */
  identifier: string;
  chars: number;
  preview: string;
}

export interface BrowserInitScriptHost {
  cdp: BrowserCdpPort;
}

export function createBrowserInitScripts(host: BrowserInitScriptHost) {
  const { cdp } = host;
  const scriptsByGuest = new WeakMap<WebContents, Map<string, RegisteredInitScript>>();
  let sequence = 0;

  function registryFor(guest: WebContents): Map<string, RegisteredInitScript> {
    let registry = scriptsByGuest.get(guest);
    if (!registry) {
      registry = new Map();
      scriptsByGuest.set(guest, registry);
    }
    return registry;
  }

  function listText(registry: Map<string, RegisteredInitScript>): string {
    if (!registry.size) return 'No init scripts are registered on this page.';
    const rows = [...registry.values()].map(
      (script) => `[${script.id}] ${script.chars} chars — ${script.preview}`,
    );
    return `Init scripts (${registry.size}), each run at the start of every navigation:\n${rows.join('\n')}`;
  }

  async function removeScript(guest: WebContents, script: RegisteredInitScript, signal?: AbortSignal): Promise<void> {
    try {
      await cdp.call(guest, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier }, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      // Chromium uses this exact message for an absent script. Missing CDP
      // sessions or targets are not proof that the script was removed.
      if (!(error instanceof Error) || error.message !== 'Script not found') throw error;
    }
    registryFor(guest).delete(script.id);
    signal?.throwIfAborted();
  }

  async function initScriptResult(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    signal?.throwIfAborted();
    const operation = String(command.operation || 'list').trim().toLowerCase();
    const registry = registryFor(guest);
    if (operation === 'list') return { text: listText(registry) };

    if (operation === 'add') {
      const source = String(command.script || '');
      if (!source.trim()) throw new Error('init_script add requires script');
      if (source.length > MAX_SCRIPT_CHARS) {
        throw new Error(`init_script source is limited to ${MAX_SCRIPT_CHARS} characters`);
      }
      if (registry.size >= MAX_SCRIPTS_PER_PAGE) {
        throw new Error(
          `this page already holds ${MAX_SCRIPTS_PER_PAGE} init scripts; remove one before adding another`,
        );
      }
      const { identifier } = await cdp.call<{ identifier: string }>(
        guest,
        'Page.addScriptToEvaluateOnNewDocument',
        { source, runImmediately: false },
        signal,
      );
      sequence += 1;
      const id = `is${sequence}`;
      registry.set(id, {
        id,
        identifier,
        chars: source.length,
        preview: source.replace(/\s+/g, ' ').trim().slice(0, 80),
      });
      signal?.throwIfAborted();
      return {
        text: `Registered init script ${id}. It runs from the next navigation onward; the document already loaded is untouched.\n\n${listText(registry)}`,
      };
    }

    if (operation === 'remove') {
      const id = String(command.scriptId || '').trim();
      const script = registry.get(id);
      if (!script) {
        throw new Error(`unknown init script ${id || '(empty)'}; list init_script to see current ids`);
      }
      await removeScript(guest, script, signal);
      return { text: `Removed init script ${id}.\n\n${listText(registry)}` };
    }

    if (operation === 'clear') {
      const removed = registry.size;
      const failures: Error[] = [];
      for (const [id, script] of registry) {
        try {
          await removeScript(guest, script, signal);
        } catch (error) {
          if (signal?.aborted) {
            throw signal.reason || error;
          }
          failures.push(new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }
      }
      if (failures.length) {
        throw new AggregateError(failures,
          `removed ${removed - failures.length} init script(s), but ${failures.length} could not be removed; retry clear\n`
          + failures.map(error => error.message).join('\n'),
        );
      }
      return { text: `Removed ${removed} init script(s).` };
    }

    throw new Error('init_script operation must be add, remove, list, or clear');
  }

  return { initScriptResult };
}
