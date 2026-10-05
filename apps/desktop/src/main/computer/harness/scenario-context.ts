import type { ChildProcess } from 'node:child_process';

import { BrowserWindow } from 'electron';
import type { ComputerHost } from '../index';
import { actionPayload } from './scenario-ocr';
import { ScenarioSkip } from './scenario-runtime';
import { foregroundHwnd, nativeHwnd } from './scenario-fixtures';
import type { BridgeDiscovery, CommandResult } from './scenario-types';

type ScenarioCommand = (input: Record<string, unknown>, sessionId?: string) => Promise<CommandResult>;

/** What every scenario group shares: the resident host, the command helper, the fixture windows and their ids. */
export interface ScenarioContext {
  host: ComputerHost;
  session: string;
  command: ScenarioCommand;
  /** Republished on a bridge restart, so scenarios read and replace it in place. */
  bridge: { discovery: BridgeDiscovery };
  windows: BrowserWindow[];
  fixture: BrowserWindow;
  fixtureWindowId: string;
  koreanWindowId: string;
  clutterWindowId: string;
  blackWindowId: string;
  whiteWindowId: string;
  denseWindowId: string;
  displayPlacement: string;
  /** Created only when a selected scenario needs it; scenarios replace it when they recreate it. */
  denseFixture: BrowserWindow | null;
  externalChild: ChildProcess | null;
  nativeDialogChild: ChildProcess | null;
  nativeTextFixturePath: string;
  externalStatePath: string;
  liveAppWindows: { mixdog?: string; chrome?: string };
  /** The OS window a turn's end must hand focus back to. */
  turnEndHome: () => Promise<bigint>;
  inputHeld: (sessionId: string) => Promise<boolean | undefined>;
}

/** One group's scenarios by id; each declares itself through `runScenario`. */
export type ScenarioGroup = Record<string, (ctx: ScenarioContext) => Promise<void>>;

/** Helpers shared by the turn-end scenarios, which span the input and recovery groups. */
export function createTurnEndHelpers(
  windows: BrowserWindow[],
  command: ScenarioCommand
): Pick<ScenarioContext, 'turnEndHome' | 'inputHeld'> {
  return {
    // A guard this process opens and focuses, or, when Windows' foreground lock
    // keeps another app in front (the last input went elsewhere), that app's window.
    turnEndHome: async () => {
      const guard = new BrowserWindow({
        width: 360,
        height: 220,
        show: true,
        title: 'Mixdog Focus Guard',
      });
      windows.push(guard);
      await guard.loadURL('data:text/html,<title>Mixdog Focus Guard</title><body>FOCUS GUARD</body>');
      guard.show();
      guard.focus();
      let home = 0n;
      for (let attempt = 0; attempt < 5 && home !== nativeHwnd(guard); attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200));
        home = await foregroundHwnd();
      }
      if (home === 0n) throw new ScenarioSkip('no window holds the OS foreground to hand focus back to');
      return home;
    },
    inputHeld: async (sessionId) => {
      const diagnostics = actionPayload(await command({ action: 'diagnose' }, sessionId));
      return (diagnostics.capabilities as { input_observation?: { input_held?: boolean } } | undefined)
        ?.input_observation?.input_held;
    },
  };
}
