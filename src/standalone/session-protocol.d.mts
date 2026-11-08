export const SESSION_READ_ACTIONS: readonly string[];
export const SESSION_CONFIGURE_ACTIONS: readonly string[];
export const SESSION_READ_ACTION_SET: ReadonlySet<string>;
export const SESSION_CONFIGURE_ACTION_SET: ReadonlySet<string>;

export interface SessionProtocolTransport {
  call(name: string, params: Record<string, unknown>, options: Record<string, unknown>): Promise<Record<string, unknown>>;
  close?(reason?: string): unknown;
}

type SessionProtocolCall = (
  params?: Record<string, unknown>,
  options?: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export interface SessionProtocolClient {
  readonly list: SessionProtocolCall;
  readonly create: SessionProtocolCall;
  readonly read: SessionProtocolCall;
  readonly subscribe: SessionProtocolCall;
  readonly unsubscribe: SessionProtocolCall;
  readonly submit: SessionProtocolCall;
  readonly abort: SessionProtocolCall;
  readonly approve: SessionProtocolCall;
  readonly configure: SessionProtocolCall;
  readonly projectList: SessionProtocolCall;
  readonly projectInspect: SessionProtocolCall;
  readonly projectAdd: SessionProtocolCall;
  readonly projectTouch: SessionProtocolCall;
  readonly projectRename: SessionProtocolCall;
  readonly projectRemove: SessionProtocolCall;
  readonly projectEnsureDirectory: SessionProtocolCall;
  readonly close: (reason?: string) => Promise<void>;
}

export function createSessionProtocolClient(rawTransport: SessionProtocolTransport): SessionProtocolClient;
