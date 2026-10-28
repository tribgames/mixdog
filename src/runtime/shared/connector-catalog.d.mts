export type ConnectorBackend =
  | {
      kind: 'oauth';
      url: string;
      /** A pre-registered client the runtime supplies instead of registration. */
      oauthClient?: 'google';
      scopes?: readonly string[];
      askTools?: readonly string[];
    }
  | {
      kind: 'apiKey';
      url?: string;
      header?: string;
      prefix?: string;
      command?: string;
      args?: readonly string[];
      env?: string;
      keyUrl: string;
      placeholder?: string;
      /** Tools that ask before they run unless the agent set them. */
      askTools?: readonly string[];
    };

export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  backend: ConnectorBackend;
  /** Curated deferred-tool manifest line (connector-triggers.mjs). */
  trigger: string;
  /** New connections go by app password only (Gmail). */
  appPasswordOnly?: boolean;
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[];
export const GOOGLE_SCOPES: Readonly<Record<'gmail' | 'calendar' | 'drive', readonly string[]>>;
export const CONNECTOR_IDS: readonly string[];
export function connectorById(id: unknown): ConnectorCatalogEntry | null;
export function connectorOfServer(cfg: unknown): string;
export function connectorToolDefault(connectorId: string, tool: string): 'auto' | 'needs_approval';
export function connectorServerInput(
  entry: ConnectorCatalogEntry,
  name: string,
  key?: string
): Record<string, unknown>;
export function connectorAppPasswordOnly(entry: ConnectorCatalogEntry | null | undefined): boolean;
export function connectorUsesGoogleClient(entry: ConnectorCatalogEntry | null | undefined): boolean;
export function connectorMultiAccount(entry: ConnectorCatalogEntry | null | undefined): boolean;
export const GMAIL_APP_PASSWORD: Readonly<{ url: string; accountHeader: string; helpUrl: string }>;
export function gmailAddress(value: unknown): string;
export function gmailAppPasswordValue(value: unknown): string;
export function gmailAppPasswordAccount(cfg: unknown): string;
export function gmailAppPasswordServerInput(name: string, email: string, password: string): Record<string, unknown>;

/** One stored account of a connector server. */
export interface ConnectorAccountEntry {
  name: string;
  /** Absent: http. */
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  oauthClientId?: string;
  /** The account's own sign-in key, when another account signs in at its URL. */
  oauthKey?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** `false`: the account is kept but neither connected nor called. */
  enabled?: boolean;
}
export function connectorAccountsUrl(id: string): string;
export function connectorAccountsOf(cfg: unknown): ConnectorAccountEntry[];
export function connectorAccountServer(
  cfg: Record<string, unknown>,
  account: ConnectorAccountEntry
): Record<string, unknown>;
export function connectorAccountServers(cfg: unknown): Record<string, unknown>[];
export function connectorAccountEnabled(account: ConnectorAccountEntry): boolean;
export function connectorLiveAccountServers(cfg: unknown): Record<string, unknown>[];
export function withConnectorAccountEnabled(
  cfg: Record<string, unknown>,
  name: string,
  enabled: boolean
): Record<string, unknown>;
export function connectorAccountEntry(name: string, cfg: Record<string, unknown>): ConnectorAccountEntry;
export function connectorServerSettings(cfg: Record<string, unknown>): Record<string, unknown>;
export function mergeConnectorAccountServers(servers: Record<string, unknown>): {
  servers: Record<string, unknown>;
  merged: { connector: string; name: string; from: string[] }[];
};
