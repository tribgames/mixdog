// A connector's mark: the brand's Simple Icons path in its brand colour on a
// neutral tile, or a letter tile where no permissively licensed mark exists
// (Slack, custom servers).
import { CONNECTOR_BRAND_ICONS } from './connectors-brand-icons';
import './connectors.css';

// Brand slugs whose catalog id differs.
const ICON_SLUGS: Record<string, string> = {
  'google-calendar': 'googlecalendar',
  'google-drive': 'googledrive',
  'hugging-face': 'huggingface',
  postgres: 'postgresql',
};

export function connectorBrandIcon(id: string) {
  return CONNECTOR_BRAND_ICONS[ICON_SLUGS[id] ?? id] ?? null;
}

export function ConnectorIcon({ id, name, className = '' }: { id: string; name: string; className?: string }) {
  const icon = connectorBrandIcon(id);
  return (
    <span className={`connector-tile ${className}`.trim()} aria-hidden="true" data-connector-icon={id || undefined}>
      {icon ? (
        <svg viewBox="0 0 24 24" role="presentation" focusable="false">
          <path d={icon.path} fill={icon.hex} />
        </svg>
      ) : (
        <b>{([...name.trim()][0] || '?').toUpperCase()}</b>
      )}
    </span>
  );
}
