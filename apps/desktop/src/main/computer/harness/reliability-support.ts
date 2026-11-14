import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { createPolling } from '../../host-harness-poll';
import { compileNativeTextFixture } from './reliability-fixtures';

const configuredDirectory = process.env.MIXDOG_RELIABILITY_DIRECTORY;
if (!configuredDirectory || !isAbsolute(configuredDirectory))
  throw new Error('an explicit fixture directory is required');
export const directory = configuredDirectory;
mkdirSync(directory, { recursive: true });
app.setPath('userData', join(directory, 'profile'));
app.on('window-all-closed', () => {});
export const results: Array<Record<string, unknown>> = [];
export const { eventually } = createPolling({ timeoutMs: 30_000, intervalMs: 150 });
export const progress = (text: string) => appendFileSync(join(directory, 'progress.log'), `${text}\n`);
export type PayloadElement = {
  role?: string;
  name?: string;
  ref?: string;
  value?: string;
  actions?: string[];
  bounds?: number[];
};
/** The fields the reliability scenarios read from a bridge command's JSON text. */
export type ReliabilityPayload = {
  ok?: boolean;
  code?: string;
  decision?: string;
  window_id?: string;
  frame_id?: string;
  elements?: PayloadElement[];
  window_transition?: { next_target?: { id?: string } };
  capture_after?: { elements?: PayloadElement[] };
};
export const payload = (value: { text: string }): ReliabilityPayload => JSON.parse(value.text);
/** The verdict fields of a reply and nothing the scenario typed or read, for an assertion message. */
export const summary = (value: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      ['ok', 'code', 'decision', 'window_id', 'frame_id'].filter((key) => key in value).map((key) => [key, value[key]])
    )
  );
/** The desktop cannot host the scenario (for example an elevated window holds
 *  the foreground no lower process may take), which is not a product failure. */
export class ScenarioPrecondition extends Error {}
// Compiled once per run: a second compile over an executable a finished
// scenario still holds fails, so every scenario launches the same build.
let compiledNativeFixture = '';
export const nativeFixturePath = () => (compiledNativeFixture ||= compileNativeTextFixture(directory));
export const childPid = (child: ChildProcess): number => {
  if (child.pid === undefined) throw new Error('the fixture process did not start');
  return child.pid;
};
export const exited = (child: ChildProcess) =>
  new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    child.once('exit', () => resolveExit());
  });

export type ScenarioOutcome = Record<string, unknown> | undefined;

/** A window of the desktop as the core's authorization names it. */
export type AuthorizationWindow = { id: string; pid: number; title?: string };

/** What every reliability scenario shares: the fixture window and the helpers over the core's commands. */
export interface ReliabilityContext {
  sentinel: BrowserWindow;
  /** One command in a session; `helperPid` is the process serving that session's helper after it ran. */
  command: (input: Record<string, unknown>, session?: string) => Promise<{ text: string; helperPid?: number }>;
  /** Every window of the desktop with its owning process, read through the session's helper. */
  authorizationWindows: (session?: string) => Promise<AuthorizationWindow[]>;
  /** Replaces the launch policy's authorization (the core stops every session's work first). */
  updateAuthorization: (authorization: Record<string, unknown>) => Promise<void>;
  /** The failure bundles the core wrote under its data directory, newest first. */
  failureBundles: () => Array<{ records: unknown[] }>;
  ownedWindow: (pid: number) => Promise<{ id: string; pid: number }>;
  edit: (id: string, name: string, value: string) => Promise<ReliabilityPayload>;
  holdForeground: (windowId: string, session: string) => Promise<void>;
}
