// The only place that binds the client library to Electron main: the library's `connect` over the WebSocket
// connector, with the desktop's identity and capabilities (protocol.md §4.3-4.4). The host role
// (`capabilities.host`) is declared by WP-DESKTOP-HOST through `capabilities`.
import {
  connect,
  sessionReducer,
  type InitializeCapabilities,
  type SectionName,
} from '../../../../../packages/protocol-client/src/index.ts';
import { SECTION_NAMES } from '../../shared/contract-sections';
import type { ConnectionClient } from './connection';
import { createWsConnector, type WsEndpoint } from './ws-connector';

// The registry is closed: a section added to the protocol must be added to SECTION_NAMES, or this stops compiling.
type MissingSections = Exclude<SectionName, (typeof SECTION_NAMES)[number]>;
const registryComplete: [MissingSections] extends [never] ? true : never = true;
void registryComplete;

export interface OpenCoreOptions {
  /** Where this connection's core listens now (re-resolved on every dial). */
  resolve(): Promise<WsEndpoint>;
  version: string;
  build?: string;
  capabilities: InitializeCapabilities;
}

export function openCore({ resolve, version, build, capabilities }: OpenCoreOptions): () => Promise<ConnectionClient> {
  const connector = createWsConnector(resolve);
  return async () => {
    const client = await connect({
      target: { id: 'core' },
      connector,
      clientInfo: { name: 'mixdog-desktop', title: 'Mixdog Desktop', version, kind: 'desktop', ...(build ? { build } : {}) },
      capabilities,
      threadReducer: sessionReducer,
      clock: { sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
      random: Math.random,
    });
    return client as unknown as ConnectionClient;
  };
}
