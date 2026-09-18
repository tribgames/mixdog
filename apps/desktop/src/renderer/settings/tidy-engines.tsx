import type { DesktopTidyEngine, DesktopTidyEngineStatus, DesktopTidyInstallStatus } from '../../shared/contract';
import { CapabilityIcon } from '../CapabilityIcon';
import { t } from '../i18n';
import {
  ExtensionItemBadge,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
} from './extension-detail';
import { engineRowState } from './tidy-status';

type EngineRow = { engine: DesktopTidyEngine } & ReturnType<typeof engineRowState>;

function EngineRows({ rows }: { rows: EngineRow[] }) {
  return (
    <ExtensionItemList>
      {rows.map(({ engine, tag, description, tone }) => (
        <ExtensionItemRow
          key={engine.id}
          icon={<CapabilityIcon name="code-tidy" size={15} />}
          title={engine.title}
          description={description}
          tone={tone}
          control={<ExtensionItemBadge tag={tag} />}
          dataAttributes={{ 'data-tidy-engine': engine.id }}
        />
      ))}
    </ExtensionItemList>
  );
}

export function TidyEngines({
  status,
  installStatus,
}: {
  status: DesktopTidyEngineStatus | null;
  installStatus: DesktopTidyInstallStatus | null;
}) {
  const isInstallingActive = installStatus?.active === true || status?.installing?.active === true;
  const rows: EngineRow[] = (status?.engines ?? [])
    .filter((e) => e.id !== 'ast-grep' && e.id !== 'ast_grep' && !e.kind?.includes('structural'))
    .map((engine) => {
      const installEngine =
        installStatus?.engines?.find((ie) => ie.id === engine.id) ??
        status?.installing?.engines?.find((ie) => ie.id === engine.id);
      return { engine, ...engineRowState({ engine, installEngine, isInstallingActive }) };
    });

  // Present, downloading and failed engines stay in view; the ones that only
  // download on first use (or need a host toolchain) fold away.
  const active = rows.filter((row) => row.state !== 'optional');
  const optional = rows.filter((row) => row.state === 'optional');
  const installedCount = rows.filter((row) => row.state === 'installed').length;

  return (
    <>
      <ExtensionSection title={t('Engines')} count={installedCount}>
        <EngineRows rows={active} />
        <ExtensionNote>
          {t('Structural rules ship with Mixdog; engines download to {{toolsDir}}.', {
            toolsDir: status?.toolsDir || '',
          })}
        </ExtensionNote>
      </ExtensionSection>
      {optional.length > 0 ? (
        <ExtensionSection title={t('Not installed')} count={optional.length} collapsible>
          <EngineRows rows={optional} />
        </ExtensionSection>
      ) : null}
    </>
  );
}
