import { t, uiFormatLocale } from '../i18n';
import type { RecordValue } from './capability-data';
import { ExtensionFacts, ExtensionSection } from './extension-detail';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatInstallDate(value: unknown): string {
  const stamp = typeof value === 'number' ? value : Date.parse(text(value));
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  try {
    return new Intl.DateTimeFormat(uiFormatLocale(), { dateStyle: 'medium' }).format(new Date(stamp));
  } catch {
    return '';
  }
}

/** Plugin-only facts: keep missing fields visible without changing other extensions. */
export function PluginInfo({ plugin }: { plugin: RecordValue }) {
  const facts: Array<[string, string]> = [
    ['Version', text(plugin.version)],
    ['Author', text(plugin.author)],
    ['Homepage', text(plugin.homepage)],
    ['Repository', text(plugin.repository)],
    ['License', text(plugin.license)],
    ['Keywords', Array.isArray(plugin.keywords) ? plugin.keywords.map(text).filter(Boolean).join(', ') : text(plugin.keywords)],
    ['Source', [text(plugin.sourceType), text(plugin.sourceUrl)].filter(Boolean).join(' · ')],
    ['Root', text(plugin.root)],
    ['MCP server', text(plugin.mcpServerName)],
    ['Installed', formatInstallDate(plugin.installedAt)],
    ['Updated', formatInstallDate(plugin.updatedAt)],
  ];
  return <ExtensionSection title={t('Info')}>
    <ExtensionFacts facts={facts.map(([label, value]) => [label, value || t('Not provided')])} />
  </ExtensionSection>;
}
