import type { App, BaseWindow, BrowserWindow, WebContents } from 'electron';

type TaggedRendererRole =
  | 'browser-login-shell'
  | 'browser-login-site'
  | 'browser-login-popup'
  | 'capture'
  | 'computer-cursor'
  | 'computer-pill'
  | 'computer-som'
  | 'desktop-pet'
  | 'file-snapshot'
  | 'host-confirm'
  | 'remote-host'
  | 'remote-screen-indicator'
  | 'remote-webrtc-sender'
  | 'visualize-export';

type RendererRole = TaggedRendererRole | 'local-shell' | 'server-shell' | 'browser-page' | 'unclassified';
type RendererContents = Pick<WebContents, 'id' | 'isDestroyed' | 'isCrashed' | 'getOSProcessId'>;
type WindowIdentity = Pick<BaseWindow, 'id'>;

interface RendererAttribution {
  rendererOsPid: number;
  webContentsId: number;
  windowId: number | null;
  role: RendererRole;
}

// Auxiliary surfaces without an existing registry: weak keys and scalar values
// let Electron collect the contents and their windows normally.
const taggedSurfaces = new WeakMap<RendererContents, { windowId: number; role: TaggedRendererRole }>();

export function tagRendererSurface(
  window: Pick<BrowserWindow, 'id' | 'webContents'>,
  role: TaggedRendererRole,
  contents = window.webContents
): void {
  taggedSurfaces.set(contents, { windowId: window.id, role });
}

interface ProcessMemorySources<T extends RendererContents> {
  getAppMetrics: App['getAppMetrics'];
  getAllWebContents(): T[];
  browserPageWindow(contents: T): WindowIdentity | null;
  ownerWindow(contents: T): WindowIdentity | null;
  connectionIdFor(webContentsId: number): string | undefined;
  localConnectionId: string;
}

function processMetrics(getAppMetrics: App['getAppMetrics']) {
  try {
    return getAppMetrics()
      .slice(0, 32)
      .map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        name: metric.name,
        serviceName: metric.serviceName,
        workingSetKb: metric.memory.workingSetSize,
        peakWorkingSetKb: metric.memory.peakWorkingSetSize,
        privateKb: metric.memory.privateBytes,
      }));
  } catch {
    return [];
  }
}

/** Working set of the app's own shell renderers only (browser pages and
 *  auxiliary surfaces excluded), with how many processes it summed. */
export function shellRendererWorkingSet(sample: ReturnType<typeof sampleProcessMemory>): {
  workingSetKb: number;
  processes: number;
} {
  const shellPids = new Set(
    sample.rendererAttribution
      .filter((row) => row.role === 'local-shell' || row.role === 'server-shell')
      .map((row) => row.rendererOsPid)
  );
  let workingSetKb = 0;
  let processes = 0;
  for (const metric of sample.processes) {
    if (!shellPids.has(metric.pid)) continue;
    workingSetKb += metric.workingSetKb || 0;
    processes += 1;
  }
  return { workingSetKb, processes };
}

export function sampleProcessMemory<T extends RendererContents>(sources: ProcessMemorySources<T>) {
  const processes = processMetrics(sources.getAppMetrics);
  const rendererAttribution: RendererAttribution[] = [];
  for (const contents of sources.getAllWebContents()) {
    try {
      if (contents.isDestroyed() || contents.isCrashed()) continue;
      const rendererOsPid = contents.getOSProcessId();
      if (rendererOsPid <= 0) continue;
      const webContentsId = contents.id;
      const tagged = taggedSurfaces.get(contents);
      if (tagged) {
        rendererAttribution.push({ rendererOsPid, webContentsId, ...tagged });
        continue;
      }
      // A Browser Use page keeps its own window identity even while its view is
      // adopted into the desktop shell for presentation.
      const pageWindow = sources.browserPageWindow(contents);
      const connectionId = sources.connectionIdFor(webContentsId);
      let role: RendererRole = 'server-shell';
      if (pageWindow) role = 'browser-page';
      else if (connectionId === undefined) role = 'unclassified';
      else if (connectionId === sources.localConnectionId) role = 'local-shell';
      const windowId = (pageWindow ?? sources.ownerWindow(contents))?.id ?? null;
      rendererAttribution.push({ rendererOsPid, webContentsId, windowId, role });
    } catch {
      // A contents can disappear during enumeration; keep the other rows.
    }
  }
  return { processes, rendererAttribution };
}
