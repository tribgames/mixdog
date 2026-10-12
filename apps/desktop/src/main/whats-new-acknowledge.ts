// The renderer's "What's new for the running version was on screen (or it has
// no notes)" signal, which retires main's pending update announcement.
import { DESKTOP_IPC } from '../shared/contract-ipc';

interface AcknowledgeEvent {
  sender: unknown;
  senderFrame: unknown;
}

type AcknowledgeListener = (event: AcknowledgeEvent, version: unknown) => void;

interface AcknowledgeIpc {
  on(channel: string, listener: AcknowledgeListener): unknown;
  removeListener(channel: string, listener: AcknowledgeListener): unknown;
}

interface AcknowledgeWindow {
  isDestroyed(): boolean;
  webContents: { mainFrame: unknown };
  once(event: 'closed', listener: () => void): unknown;
}

interface AcknowledgeOptions {
  /** The running app version: the only one a renderer may acknowledge. */
  version: string;
  /** Settles once this launch's record is written; acknowledging waits for it. */
  launchRecorded(): Promise<unknown>;
  acknowledge(version: string): Promise<void>;
}

/** Accepts the acknowledgement only from `window`'s main frame, for the
 *  running version; listens until the window closes. Returns the remover. */
export function installWhatsNewAcknowledge(
  ipc: AcknowledgeIpc,
  window: AcknowledgeWindow,
  { version, launchRecorded, acknowledge }: AcknowledgeOptions
): () => void {
  const listener: AcknowledgeListener = (event, acknowledged) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      acknowledged !== version
    )
      return;
    void launchRecorded()
      .catch(() => undefined)
      .then(() => acknowledge(version));
  };
  const remove = () => ipc.removeListener(DESKTOP_IPC.acknowledgeWhatsNew, listener);
  ipc.on(DESKTOP_IPC.acknowledgeWhatsNew, listener);
  window.once('closed', remove);
  return remove;
}
