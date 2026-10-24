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
  key?: string,
  options?: { extraAccount?: boolean }
): Record<string, unknown>;
export function connectorAppPasswordOnly(entry: ConnectorCatalogEntry | null | undefined): boolean;
export function connectorUsesGoogleClient(entry: ConnectorCatalogEntry | null | undefined): boolean;
export function connectorMultiAccount(entry: ConnectorCatalogEntry | null | undefined): boolean;
export const GMAIL_APP_PASSWORD: Readonly<{ url: string; accountHeader: string; helpUrl: string }>;
export function gmailAddress(value: unknown): string;
export function gmailAppPasswordValue(value: unknown): string;
export function gmailAppPasswordAccount(cfg: unknown): string;
export function gmailAppPasswordServerInput(name: string, email: string, password: string): Record<string, unknown>;
