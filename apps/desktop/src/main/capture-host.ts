// What the capture profile holds. The capture window talks to a real core like any window (capture-core.ts); the
// profile that core starts from is described here: the settings the shipped surface reads, the Lead route, the files
// of the project the tool showcase edits, and the scripted model answers of that showcase.

// MIXDOG_JITTER_PROBE: '1' = streaming/follow pass, 'entry' = cold-entry and
// tool-toggle pass, 'keys' = keyboard paging pass, 'switch' = rapid session
// switching, warm paint handoff, and side-panel geometry pass, 'width' = the
// window-width rewrap pass.
export function jitterProbeEnabled(): boolean {
  const mode = String(process.env.MIXDOG_JITTER_PROBE || '');
  return (
    mode === '1' || mode === 'entry' || mode === 'keys' || mode === 'switch' || mode === 'width' || mode === 'select'
  );
}

/** The settings the capture profile stores, in the shape their getters answer. The scripted model endpoint answers its
 *  queue in request order, so no request of the core's own (a session title) may take a slot: AI titles are off here. */
export const CAPTURE_SETTINGS_VALUES = {
  getHeartbeatSettings: { heartbeat: false, intervalMinutes: 60 },
  getReactionSettings: { reactions: true },
  getSessionTitleSettings: { aiSessionTitles: false },
  getCacheWarmingSettings: { enabled: false },
  getRecapSettings: { enabled: true },
} as const;

/** The route the Lead runs on in the capture profile: the scripted endpoint (scripts/live/lib/provider.mjs). */
export interface CaptureRoute {
  provider: string;
  model: string;
}

/** The `agent` section of the profile's mixdog-config.json: onboarding done (a fresh profile would cover the UI with
 *  the wizard), every action allowed (the showcase's tools run without an approval card), the stored settings above, the
 *  scripted provider and the Lead's route to it. */
export function captureAgentConfig(
  providers: Record<string, unknown>,
  route: CaptureRoute,
  now: Date = new Date(),
  values: typeof CAPTURE_SETTINGS_VALUES = CAPTURE_SETTINGS_VALUES
): Record<string, unknown> {
  return {
    providers,
    agents: { lead: { provider: route.provider, model: route.model } },
    heartbeat: values.getHeartbeatSettings.heartbeat,
    heartbeatIntervalMinutes: values.getHeartbeatSettings.intervalMinutes,
    reactions: values.getReactionSettings.reactions,
    aiSessionTitles: values.getSessionTitleSettings.aiSessionTitles,
    promptCacheWarming: values.getCacheWarmingSettings.enabled,
    recap: { enabled: values.getRecapSettings.enabled },
    developer: { allowAllActions: true },
    onboarding: {
      completed: true,
      version: 1,
      completedAt: now.toISOString(),
      skipped: true,
      starterGuide: { closed: true, welcomed: true, visited: [] },
    },
  };
}

/** The project the tool showcase edits: its files by path, and the prompt the composer submits. */
export const CAPTURE_SHOWCASE_PROMPT = 'Run the test suite and fix the retry regression.';

export const CAPTURE_PROJECT_FILES: Readonly<Record<string, string>> = {
  'src/app.ts': 'const config = loadConfig();\nconst retries = 1;\nboot({ config, retries });\n',
  // A command that succeeds, one that fails, and one that keeps running with output on screen.
  'tools/typecheck.mjs': "console.log('> tsc -p tsconfig.node.json');\nconsole.log('Typecheck passed in 4.2s.');\n",
  'tools/test.mjs':
    "console.log('1) retry configuration');\nconsole.error('   AssertionError: expected retries to equal 3, got 1');\nprocess.exit(1);\n",
  'tools/suite.mjs':
    "console.log('> vitest run');\nconsole.log('\u2713 retry configuration (3 tests)');\nconsole.log('\u2713 boot sequence (5 tests)');\nconsole.log('running suite: integration \u2026');\nsetInterval(() => {}, 1000);\n",
};

/** The scripted model answers of the showcase, in request order: three calls (a command that passes, one that fails, an
 *  edit), then prose followed by a command that is still running when the frames are taken. Paths are absolute and use
 *  forward slashes, which every shell and Node accept. */
export function captureShowcaseAnswers(projectPath: string): object[] {
  const file = (relative: string): string => `${projectPath.replaceAll('\\', '/')}/${relative}`;
  const run = (relative: string): string => `node "${file(relative)}"`;
  return [
    {
      calls: [
        { name: 'bash', args: { command: run('tools/typecheck.mjs'), description: 'Typecheck the main process' } },
        { name: 'bash', args: { command: run('tools/test.mjs') } },
        { name: 'edit', args: { path: file('src/app.ts'), old_string: 'const retries = 1;', new_string: 'const retries = 3;' } },
      ],
    },
    {
      text: 'Retry count fixed — rerunning the suite now.',
      calls: [{ name: 'bash', args: { command: run('tools/suite.mjs') } }],
    },
  ];
}
