// A bot's per-tool connector permissions, under the connector's row in its
// profile: every tool with the permission it has (the tool's own, so a
// connector switched off does not change it) and a three-way choice that saves
// at once (setAgentConnectorToolPermission). A paired remote client may only
// narrow what a bot may do (remote-authority.ts), so there the choices that
// would widen are disabled; the host judges the same rule when it writes.
import type { DesktopApi } from '../shared/contract';
import { t } from './i18n';
import { createKeyedReadCache } from './keyed-read-cache';
import { isRemoteHostRenderer } from './remote-ui-projection';

export type ConnectorToolsApi = Partial<Pick<DesktopApi, 'invokeCapability'>>;
export type ConnectorToolPermission = 'auto' | 'needs_approval' | 'disabled';
export interface ConnectorToolRow {
  connector: string;
  tool: string;
  /** What the tool has on its own: its override, else its default. */
  permission: ConnectorToolPermission;
  /** The bot's own policy holds an entry for it. */
  explicit: boolean;
}

const PERMISSIONS: readonly ConnectorToolPermission[] = ['auto', 'needs_approval', 'disabled'];
/** How much a permission lets the bot do without asking (the host's PERMISSION_RANK). */
const RANK: Record<ConnectorToolPermission, number> = { disabled: 0, needs_approval: 1, auto: 2 };

/** The host's `[{ connector, tool, permission, explicit }]` rows, defensively typed. */
export function connectorToolRows(value: unknown): ConnectorToolRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (row) =>
        row &&
        typeof row.connector === 'string' &&
        typeof row.tool === 'string' &&
        PERMISSIONS.includes(row.permission)
    )
    .map((row) => ({
      connector: row.connector,
      tool: row.tool,
      permission: row.permission,
      explicit: row.explicit === true,
    }));
}

/** Each bot's tool rows (keyed-read-cache), like the connector switches beside them. */
export const connectorToolsCache = createKeyedReadCache<ConnectorToolRow[]>();
export const connectorToolsReader = (api: ConnectorToolsApi | undefined, agentId: string) => async () =>
  connectorToolRows((await api?.invokeCapability?.({ capability: 'getAgentConnectorTools', args: [agentId] }))?.value);

/** Reads a bot's tool rows into that cache before its profile opens. */
export async function prefetchConnectorTools(api: ConnectorToolsApi | undefined, agentId: string): Promise<void> {
  await connectorToolsCache.load(agentId, connectorToolsReader(api, agentId));
}

/** Whether a paired client's choice would give the bot more authority. The host
 *  compares against the tool's override, and a tool without one counts as
 *  asking (connectorPolicyWidens), so even its default `auto` cannot be set. */
function widens(row: ConnectorToolRow, choice: ConnectorToolPermission): boolean {
  return RANK[choice] > (row.explicit ? RANK[row.permission] : RANK.needs_approval);
}

const LABELS: Record<ConnectorToolPermission, () => string> = {
  auto: () => t('Auto'),
  needs_approval: () => t('Needs approval'),
  disabled: () => t('Disabled'),
};

export function ConnectorToolPermissions({
  connector,
  tools,
  enabled,
  busy,
  onChoose,
}: {
  connector: string;
  tools: ConnectorToolRow[];
  /** The connector's switch: off dims the list and disables its choices. */
  enabled: boolean;
  busy: boolean;
  onChoose: (tool: string, permission: ConnectorToolPermission) => void;
}) {
  const remote = isRemoteHostRenderer();
  return (
    <div className="connector-tools" data-connector-tools={connector} data-dim={enabled ? undefined : ''}>
      <p className="connector-tools-note">
        {enabled
          ? t('The bot can only narrow these; widening happens here.')
          : t('The connector is off, so these tools are not used.')}
      </p>
      {enabled && remote && (
        <p className="connector-tools-note" data-connector-tools-remote="">
          {t('To widen, change it on the PC or ask the bot.')}
        </p>
      )}
      {tools.map((row) => (
        <div key={row.tool} className="connector-tool" data-connector-tool={row.tool}>
          <span className="connector-tool-name" title={row.tool}>
            {row.tool}
          </span>
          <span className="mx-segmented connector-tool-seg" role="group" aria-label={row.tool}>
            {PERMISSIONS.map((choice) => (
              <button
                key={choice}
                type="button"
                data-permission={choice}
                title={LABELS[choice]()}
                aria-pressed={row.permission === choice}
                disabled={!enabled || busy || (remote && row.permission !== choice && widens(row, choice))}
                onClick={() => {
                  if (row.permission !== choice) onChoose(row.tool, choice);
                }}
              >
                <span>{LABELS[choice]()}</span>
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
