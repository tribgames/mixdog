// The capture window's core. The window is a client of a core like any other: this starts an isolated mixdogd whose
// profile lives under the capture's user-data directory, seeded from capture-host.ts (settings, Lead route, a project to
// edit) and answering its model calls from a scripted local endpoint, and hands the window its port through the same
// CorePortRelay a main window uses. Nothing here reads or writes the person's own profile: every location the core
// reads is one of the profile's folders.
//
// PARITY (what the capture host served, and what serves it now)
//   what the old capture host answered            now provided by
//   listSessions / listProjects / listAgentPool    the core (empty profile; a new task is a real thread)
//   getSnapshot / subscribe* / setVisibleSessions  the core over the window's port (core-direct sessions)
//   submitNewTask / startTask / abortSession       the core: thread/start, turn/start on the scripted endpoint
//   listProviderModels                             the core, from the scripted provider's one model
//   readCapabilities / invokeCapability values     the core's config: heartbeat, reactions, AI titles, cache warming,
//                                                  recap, onboarding done (captureAgentConfig); the rest of the
//                                                  settings a fresh profile answers by itself
//   getTheme / setTheme                            the core's capability lane
//   getUpdaterState / checkForDesktopUpdate        host method of the capture process (capture-window.ts)
//   pane layout, screen sessions, title bar theme  host methods of the capture process (capture-window.ts)
//   publishProbeSnapshot (tool showcase)           a real turn on the scripted endpoint (captureShowcaseAnswers)
//   transcribeAudio / voice status                 the core's voice runtime: present only where one is installed
//   prepareJitter* / publishProbeSnapshot (probe)  none: see capture-window.ts (the probe has no seam on a core)
//   every other answer was an empty value or a refusal ("unavailable in UI capture") and is now whatever the core
//   answers from its empty profile.
//
// assertions (capture-assertions.ts): readDesktopAssertions, readLightThemeAssertions, readMobileClosedAssertions,
// readMobileOpenAssertions, readModalStackAssertions, readPhoneSettingsAssertions and readSettingsPlacement read the
// renderer's DOM and measure rects; the core feeds them only the rows the renderer paints (sessions, settings), which the
// profile above gives.
import type { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CAPTURE_PROJECT_FILES, captureAgentConfig, captureShowcaseAnswers } from './capture-host';
import { CorePortRelay, type CoreEndpoint, type CorePortRelayOptions } from './core-port/relay';
import { requestCoreStop, resolveLocalCore, type CoreProcess } from './protocol/local-core';
import { openCore } from './protocol/open-core';
import type { WsEndpoint } from './protocol/ws-connector';

/** Where the capture core keeps everything. */
export interface CaptureProfile {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly runtime: string;
  readonly bridges: string;
  readonly project: string;
  readonly config: string;
}

export function captureProfile(userData: string): CaptureProfile {
  const root = join(resolve(userData), 'core-profile');
  return {
    root,
    home: join(root, 'home'),
    data: join(root, 'data'),
    runtime: join(root, 'runtime'),
    bridges: join(root, 'bridges'),
    project: join(root, 'project'),
    config: join(root, 'data', 'mixdog-config.json'),
  };
}

/** The environment of the capture core: the parent's, with every store the core reads or writes moved into the profile
 *  and the relay off, so a core started from a shell that carries the installed app's paths still touches none of them. */
export function captureCoreEnvironment(
  profile: CaptureProfile,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // The names the app and the core own are the parent's; only the binary the harness named is kept.
    if (!/^(MIXDOG_|MIXDOGD_)/i.test(key) || key.toUpperCase() === 'MIXDOGD_BIN') env[key] = value;
  }
  return {
    ...env,
    MIXDOG_DESKTOP_USER_DATA: profile.root,
    MIXDOG_HOME: profile.home,
    MIXDOG_CONFIG_DIR: profile.home,
    MIXDOG_USER_DATA_BACKUP_ROOT: join(profile.home, 'backups', 'user-data'),
    MIXDOG_DATA_DIR: profile.data,
    MIXDOG_RUNTIME_ROOT: profile.runtime,
    MIXDOG_BRIDGE_DISCOVERY_DIR: profile.bridges,
    MIXDOG_PROJECTS_FILE: join(profile.root, 'projects.json'),
    MIXDOG_DISABLE_PROJECT_MARKERS: '1',
    MIXDOG_RELAY_URL: 'off',
  };
}

/** The scripted model endpoint the profile's provider points at (scripts/live/lib/provider.mjs). */
export interface CaptureProvider {
  readonly baseURL: string;
  readonly state: { readonly queue: object[] };
  close(): Promise<void>;
}

export interface CaptureProviderModule {
  startProvider(): Promise<CaptureProvider>;
  providerConfig(baseURL: string): { agent: { providers: Record<string, unknown> } };
  customProviderId: string;
}

async function loadProviderModule(): Promise<CaptureProviderModule> {
  // The live runner's own provider and ids: one scripted endpoint for every harness. They are plain modules without
  // declarations, and the capture is a development harness (a packaged build excludes it).
  // @ts-ignore TS7016: no declaration file beside scripts/live/lib
  const provider = await import('../../../../scripts/live/lib/provider.mjs');
  // @ts-ignore TS7016: no declaration file beside scripts/live/lib
  const paths = await import('../../../../scripts/live/lib/paths.mjs');
  return {
    startProvider: provider.startProvider,
    providerConfig: provider.providerConfig,
    customProviderId: paths.CUSTOM as string,
  };
}

export interface CaptureFixtures {
  /** The files of the project the showcase edits, by relative path. */
  projectFiles: Readonly<Record<string, string>>;
  /** The scripted answers of the showcase for a project at `projectPath`. */
  showcaseAnswers(projectPath: string): object[];
  now?(): Date;
}

export const captureFixtures: CaptureFixtures = {
  projectFiles: CAPTURE_PROJECT_FILES,
  showcaseAnswers: captureShowcaseAnswers,
};

/** What `startCaptureCore` leans on, replaceable by a test. */
export interface CaptureCoreDependencies {
  loadProvider?(): Promise<CaptureProviderModule>;
  /** The attach-or-start routine of the core (protocol/local-core.ts `resolveLocalCore`). */
  resolveCore?: typeof resolveLocalCore;
  /** The link main keeps to the core: it reports the window scope the relay needs. */
  openLink?(
    resolveEndpoint: () => Promise<WsEndpoint>,
    onScope: (scope: number | null) => void
  ): Promise<{ close(): Promise<void> }>;
  spawnImpl?: typeof spawn;
  bin?: string;
  baseEnv?: NodeJS.ProcessEnv;
  version?: string;
}

export interface CaptureCore {
  readonly endpoint: WsEndpoint;
  readonly profile: CaptureProfile;
  /** The project the showcase edits (an absolute path inside the profile). */
  readonly projectPath: string;
  /** The window scope the core's initialize reply carried; null when it does not speak it. */
  windowScope(): number | null;
  /** Queues the showcase's model answers on the scripted endpoint. */
  queueShowcase(): void;
  stop(): Promise<void>;
}

const STOP_TIMEOUT_MS = 10_000;

async function defaultOpenLink(
  resolveEndpoint: () => Promise<WsEndpoint>,
  onScope: (scope: number | null) => void,
  version: string
): Promise<{ close(): Promise<void> }> {
  const client = await openCore({
    resolve: resolveEndpoint,
    version,
    capabilities: { approvalsInbox: true },
    onInitialized: (reply) => {
      const scope = reply.capabilities?.windowScope;
      onScope(typeof scope === 'number' && scope > 0 ? scope : null);
    },
  })();
  return { close: () => client.close() };
}

export async function startCaptureCore(
  { userData, fixtures = captureFixtures }: { userData: string; fixtures?: CaptureFixtures },
  dependencies: CaptureCoreDependencies = {}
): Promise<CaptureCore> {
  const baseEnv = dependencies.baseEnv ?? process.env;
  const bin = dependencies.bin ?? baseEnv.MIXDOGD_BIN ?? '';
  if (!bin) throw new Error('The capture core needs MIXDOGD_BIN to name the built mixdogd.');
  const profile = captureProfile(userData);
  for (const directory of [profile.home, profile.data, profile.runtime, profile.bridges, profile.project]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const [relative, content] of Object.entries(fixtures.projectFiles)) {
    const file = join(profile.project, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const providerModule = await (dependencies.loadProvider ?? loadProviderModule)();
  const provider = await providerModule.startProvider();
  let child: CoreProcess | null = null;
  let link: { close(): Promise<void> } | null = null;
  const closeAll = async (): Promise<void> => {
    await link?.close().catch(() => {});
    await provider.close().catch(() => {});
  };
  try {
    const agent = captureAgentConfig(
      providerModule.providerConfig(provider.baseURL).agent.providers,
      { provider: providerModule.customProviderId, model: 'smoke' },
      fixtures.now?.()
    );
    writeFileSync(profile.config, JSON.stringify({ agent }, null, 2));
    const env = captureCoreEnvironment(profile, baseEnv);
    const resolveEndpoint = (dependencies.resolveCore ?? resolveLocalCore)({
      runtimeRoot: profile.runtime,
      bin,
      env: () => env,
      environmentReady: () => Promise.resolve(),
      onLaunched: (launched) => {
        child = launched;
      },
      ...(dependencies.spawnImpl ? { spawnImpl: dependencies.spawnImpl } : {}),
    });
    const endpoint = await resolveEndpoint();
    let scope: number | null = null;
    const onScope = (value: number | null): void => {
      scope = value;
    };
    link = await (dependencies.openLink
      ? dependencies.openLink(resolveEndpoint, onScope)
      : defaultOpenLink(resolveEndpoint, onScope, dependencies.version ?? '0.0.0'));
    return {
      endpoint,
      profile,
      projectPath: profile.project,
      windowScope: () => scope,
      queueShowcase: () => {
        provider.state.queue.push(...fixtures.showcaseAnswers(profile.project));
      },
      async stop() {
        await closeAll();
        await requestCoreStop({
          child,
          bin,
          runtimeRoot: profile.runtime,
          env,
          timeoutMs: STOP_TIMEOUT_MS,
          ...(dependencies.spawnImpl ? { spawnImpl: dependencies.spawnImpl } : {}),
        });
      },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

/** The relay a capture window opens its port through: one endpoint, this core, under the role a main window has. */
export function createCaptureRelay(
  core: Pick<CaptureCore, 'endpoint' | 'windowScope'>,
  options: Pick<CorePortRelayOptions, 'createSocket' | 'createChannel' | 'log'> = {}
): CorePortRelay {
  const endpoints: CoreEndpoint[] = [
    { slot: 'primary', url: core.endpoint.url, token: core.endpoint.token, target: 'local', role: 'main' },
  ];
  return new CorePortRelay({
    endpointFor: async () => endpoints,
    coreWindowScope: async () => core.windowScope(),
    ...options,
  });
}
