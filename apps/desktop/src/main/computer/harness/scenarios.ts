import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';
import { createComputerHost, type ComputerHost } from '../index';
import { createComputerUseOverlay, type ComputerUseOverlay } from '../overlay';
import { compileNativeTextFixture } from '../backend/native-fixture';
import { createTurnEndHelpers, type ScenarioContext, type ScenarioGroup } from './scenario-context';
import { externalFixtureProgram } from './scenario-fixture-html';
import { createDenseFixture, createScenarioFixtureWindows, fixtureWindowIds } from './scenario-fixtures';
import { SCENARIO_GROUPS, SCENARIO_RUN_ORDER, unknownScenarioIds } from './scenario-ids';
import {
  createScenarioCommand,
  dataDirectory,
  isScenarioDeclared,
  profile,
  progress,
  readDiscovery,
  scenarioOnly,
  writeScenarioReport,
} from './scenario-runtime';
import { externalScenarios } from './scenarios-external';
import { inputScenarios } from './scenarios-input';
import { observationScenarios } from './scenarios-observation';
import { performanceScenarios } from './scenarios-performance';
import { realAppsScenarios } from './scenarios-real-apps';
import { recoveryScenarios } from './scenarios-recovery';

const scenarioGroups: Record<string, ScenarioGroup> = {
  observation: observationScenarios,
  input: inputScenarios,
  recovery: recoveryScenarios,
  external: externalScenarios,
  'real-apps': realAppsScenarios,
  performance: performanceScenarios,
};

/** The group modules and the group map must name the same scenarios, so a mismatch fails before any fixture work. */
function scenarioDeclarations(): Record<string, ScenarioGroup[string]> {
  const declarations: Record<string, ScenarioGroup[string]> = {};
  for (const [group, ids] of Object.entries(SCENARIO_GROUPS)) {
    const declared = Object.keys(scenarioGroups[group] ?? {});
    if (declared.length !== ids.length || !ids.every((id) => declared.includes(id))) {
      throw new Error(`scenario group ${group} does not declare exactly ${ids.join(', ')}`);
    }
    Object.assign(declarations, scenarioGroups[group]);
  }
  return declarations;
}

async function run(): Promise<void> {
  // A typo in --only has to fail here, before any fixture work: checked during
  // cleanup it masked the real scenario failure and skipped the report.
  const unknown = unknownScenarioIds(scenarioOnly);
  if (unknown.length) throw new Error(`unknown scenario id(s): ${unknown.join(', ')}`);
  const declarations = scenarioDeclarations();
  let host: ComputerHost | null = null;
  let overlay: ComputerUseOverlay | null = null;
  let externalChild: ChildProcess | null = null;
  let context: ScenarioContext | null = null;
  const windows: BrowserWindow[] = [];
  const session = 'computer-scenario-main';
  let displayPlacement = '';
  let nativeTextFixturePath = '';
  let denseFixture: BrowserWindow | null = null;
  const needsDenseFixture = !scenarioOnly.size || ['S24', 'S25', 'S26', 'S29'].some((id) => scenarioOnly.has(id));
  const needsNativeTextFixture = !scenarioOnly.size || scenarioOnly.has('S20');

  try {
    progress('SETUP app ready');
    // This harness is its own Electron app: the activity overlay and pointer
    // feedback the product shows only appear while this process owns them too.
    if (process.env.MIXDOG_COMPUTER_SCENARIO_OVERLAY !== 'off') {
      overlay = createComputerUseOverlay(
        {
          stop: async () => {
            host?.takeOver('user_stop');
          },
          pause: async () => {
            host?.takeOver('user_pause');
          },
        },
        'ko'
      );
      progress('SETUP activity overlay ready');
    }
    if (needsNativeTextFixture) {
      nativeTextFixturePath = compileNativeTextFixture(profile);
      progress('SETUP native text fixture ready');
    }
    if (needsDenseFixture) app.setAccessibilitySupportEnabled(true);
    const { fixture, displayPlacement: fixturePlacement } = await createScenarioFixtureWindows(windows);
    displayPlacement = fixturePlacement;

    if (needsDenseFixture) {
      denseFixture = await createDenseFixture();
      windows.push(denseFixture);
      progress('SETUP dense accessibility fixture ready');
    }

    const externalStatePath = join(profile, 'external-state.json');
    if (!scenarioOnly.size || scenarioOnly.has('S19')) {
      const externalProgramPath = join(profile, 'external-fixture.mjs');
      writeFileSync(
        externalProgramPath,
        externalFixtureProgram(externalStatePath, join(profile, 'external-user-data')),
        'utf8'
      );
      const externalEnv = { ...process.env };
      delete externalEnv.ELECTRON_RUN_AS_NODE;
      externalChild = spawn(process.execPath, [externalProgramPath], {
        env: externalEnv,
        stdio: 'inherit',
        windowsHide: false,
      });
      progress('SETUP external fixture spawned');
    }

    host = createComputerHost();
    progress('SETUP resident host created');
    const bridge = { discovery: await readDiscovery(join(dataDirectory, 'computer-bridge.json'), 45_000) };
    progress('SETUP resident host discovered');
    const command = createScenarioCommand(session, () => bridge.discovery);

    const setupWindows = (await command({ action: 'list_windows' }, '__computer_scenario_setup__')).text;
    const setupIds = fixtureWindowIds(setupWindows);
    assert.ok(
      setupIds.fixture &&
        setupIds.korean &&
        setupIds.clutter &&
        setupIds.black &&
        setupIds.white &&
        (!denseFixture || setupIds.dense),
      setupWindows
    );
    progress('SETUP exact fixture windows resolved');

    context = {
      host,
      session,
      command,
      bridge,
      windows,
      fixture,
      fixtureWindowId: setupIds.fixture,
      koreanWindowId: setupIds.korean,
      clutterWindowId: setupIds.clutter,
      blackWindowId: setupIds.black,
      whiteWindowId: setupIds.white,
      denseWindowId: setupIds.dense,
      displayPlacement,
      denseFixture,
      externalChild,
      nativeDialogChild: null,
      nativeTextFixturePath,
      externalStatePath,
      liveAppWindows: { mixdog: setupIds.mixdog, chrome: setupIds.chrome },
      ...createTurnEndHelpers(windows, command),
    };
    for (const id of SCENARIO_RUN_ORDER) {
      await declarations[id](context);
      assert.ok(isScenarioDeclared(id), `scenario ${id} did not declare itself`);
    }
  } finally {
    overlay?.dispose();
    externalChild?.kill();
    context?.nativeDialogChild?.kill();
    await host?.dispose();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    writeScenarioReport(displayPlacement);
  }
}

void app
  .whenReady()
  .then(async () => {
    await run();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    app.exit(1);
  });
