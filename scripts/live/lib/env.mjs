// One live environment: a scripted provider and local fixture pages in this process, an isolated desktop instance
// (Electron + the Rust core) started under the run's own root, a protocol client of that core and, optionally, CDP
// handles to the Electron main and the renderer. `close(outDir)` copies the instance's history/logs out first.
import { attach } from './core-client.mjs';
import { cpuSample } from './cpu.mjs';
import { startFixtures } from './fixtures.mjs';
import { connectMain, connectRenderer } from './inspector.mjs';
import { collect, freePort, instanceController, prepareCore, verifyCore, waitCore } from './instance.mjs';
import { DESKTOP_DIR, REPO_ROOT, findOrtLibrary } from './paths.mjs';
import { providerConfig, providerControl, startProvider } from './provider.mjs';

/** `overlay` laid over `base`: plain objects merge key by key, everything else (arrays included) is replaced. Neither is changed. */
export function mergeOverlay(base, overlay) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(base) || !isObject(overlay)) return overlay === undefined ? base : overlay;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) out[key] = key in out ? mergeOverlay(out[key], value) : value;
  return out;
}

/** The config the instance starts with: the scripted provider, Browser Use on (the desktop starts its browser bridge only with it), then the caller's overlay. */
export function instanceConfig(providerBaseURL, configOverlay = {}) {
  return mergeOverlay(
    { ...providerConfig(providerBaseURL), desktop: { browserControl: true, browserInstalled: true } },
    configOverlay
  );
}

/**
 * Starts provider, fixtures and the instance. `coreExe` is the built mixdogd, `desktopDir` the checkout's apps/desktop,
 * `isoRoot` the root every instance of the run lives under (nothing else is touched), `electronDist` an Electron
 * dist folder to use as it is (optional), `inspector` whether the Electron main's V8 inspector is opened.
 */
export async function openEnvironment({ coreExe, isoRoot, desktopDir = DESKTOP_DIR, repoRoot = REPO_ROOT, ortLibrary = findOrtLibrary({ desktopDir, repoRoot }), electronDist, inspector = false, configOverlay, passEnv, log = console.log }) {
  const cpuBeforeStart = await cpuSample(2);
  const coreBuild = await prepareCore({ coreExe, desktopDir, repoRoot, isoRoot, ortLibrary, log });
  const controller = instanceController({ desktopDir, coreExe: coreBuild.exe, isoRoot, electronDist, log });
  const provider = await startProvider();
  const fixtures = await startFixtures();
  const inspectorPort = inspector ? await freePort() : null;
  let info;
  try {
    info = await controller.start({ inspectorPort, config: instanceConfig(provider.baseURL, configOverlay), passEnv });
  } catch (error) {
    await provider.close();
    await fixtures.close();
    throw error;
  }
  const doc = await waitCore(info);
  const coreCheck = await verifyCore(doc, coreBuild.exe);
  log(`core: pid ${coreCheck.pid} ${coreCheck.executablePath} ours=${coreCheck.ours}`);
  if (!coreCheck.ours) log('WARNING: the serving core is NOT the binary this run staged; the run is not the environment it claims');
  const core = await attach(info.profile, { log });
  const main = inspector ? await connectMain(inspectorPort) : null;
  const control = {
    ...providerControl(provider.baseURL),
    push: async (answers) => ({ queued: provider.state.queue.push(...answers) }),
    route: async (match, answers) => ({ routes: provider.state.routes.push({ match, answers: [...answers] }) }),
    reset: async () => {
      provider.state.queue.length = 0;
      provider.state.routes.length = 0;
      return { ok: true };
    },
  };
  return {
    info,
    doc,
    coreCheck,
    coreBuild,
    core,
    main,
    provider: control,
    fixtures,
    cpuBeforeStart,
    /** The instance's renderer page (the main window) over CDP. */
    renderer: () => connectRenderer(info.cdpPort, info.rendererPort),
    async close(outDir) {
      if (outDir) collect(info, outDir, log);
      main?.cdp.close();
      await core.close().catch(() => {});
      await controller.stop();
      await provider.close();
      await fixtures.close();
    },
  };
}

/** The exact conditions of a run, for every summary. */
export function conditions(env, extra = {}) {
  return {
    coreBinary: env.coreCheck?.executablePath,
    coreSource: env.coreBuild ? { path: env.coreBuild.path, size: env.coreBuild.size, mtimeMs: env.coreBuild.mtimeMs } : null,
    coreVerified: env.coreCheck?.ours ?? null,
    corePid: env.coreCheck?.pid,
    os: `${process.platform} ${process.arch}`,
    instance: { profile: env.info?.profile, dataDir: env.info?.dataDir, cdpPort: env.info?.cdpPort, inspectorPort: env.info?.inspectorPort },
    pages: 'local fixtures only (127.0.0.1 / 127.0.0.2); no public sites',
    ...extra,
  };
}
