import type { DesktopTidyEngineStatus, DesktopTidyInstallStatus } from '../../shared/contract';
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

export function TidyEngines({
  status,
  installStatus,
}: {
  status: DesktopTidyEngineStatus | null;
  installStatus: DesktopTidyInstallStatus | null;
}) {
  const rawEngines = status?.engines ?? [];
  const engines = rawEngines.filter(
    (e) => e.id !== 'ast-grep' && e.id !== 'ast_grep' && !e.kind?.includes('structural')
  );
  const installedCount = engines.filter((e) => {
    const installEngine =
      installStatus?.engines?.find((ie) => ie.id === e.id) ?? status?.installing?.engines?.find((ie) => ie.id === e.id);
    if (installEngine?.status === 'installed' || installEngine?.status === 'present') return true;
    if (installEngine?.status === 'failed' || installEngine?.status === 'skipped') return false;
    return e.source === 'managed' || e.source === 'host';
  }).length;

  const isInstallingActive = installStatus?.active === true || status?.installing?.active === true;

  return (
    <ExtensionSection title={t('Engines')} count={installedCount}>
      <ExtensionItemList>
        {engines.map((engine) => {
          const installEngine =
            installStatus?.engines?.find((ie) => ie.id === engine.id) ??
            status?.installing?.engines?.find((ie) => ie.id === engine.id);
          const { tag, description, tone } = engineRowState({
            engine,
            installEngine,
            isInstallingActive,
          });
          return (
            <ExtensionItemRow
              key={engine.id}
              icon={<CapabilityIcon name="code-tidy" size={15} />}
              title={engine.title}
              description={description}
              tone={tone}
              control={<ExtensionItemBadge tag={tag} />}
              dataAttributes={{ 'data-tidy-engine': engine.id }}
            />
          );
        })}
      </ExtensionItemList>
      <ExtensionNote>
        {t('Structural rules ship with Mixdog; engines download to {{toolsDir}}.', {
          toolsDir: status?.toolsDir || '',
        })}
      </ExtensionNote>
    </ExtensionSection>
  );
}
