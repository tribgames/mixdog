import { Globe, Monitor, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';

import type { RemoteClientKind } from '../../shared/remote-trust';

/** The glyph of a device kind, shared by list rows and the approval dialog. */
export function KindIcon({ kind, size = 16 }: { kind: RemoteClientKind; size?: number }) {
  if (kind === 'app') return <Smartphone size={size} aria-hidden="true" />;
  if (kind === 'browser') return <Globe size={size} aria-hidden="true" />;
  return <Monitor size={size} aria-hidden="true" />;
}

/** One 56px list row: icon tile, name with an optional status, a meta line and
 *  trailing actions. */
export function ConnRow({
  icon,
  title,
  status,
  statusTone = 'off',
  meta,
  extra,
  actions,
}: {
  icon: ReactNode;
  title: string;
  status?: string;
  statusTone?: 'on' | 'off';
  meta: string;
  /** A line below the meta (the device's notification summary). */
  extra?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="conn-row">
      <span className="conn-tile">{icon}</span>
      <div className="conn-row-text">
        <div className="conn-row-title">
          <b>{title}</b>
          {status && <span className={`conn-status conn-status--${statusTone}`}>{status}</span>}
        </div>
        <div className="conn-row-meta">{meta}</div>
        {extra}
      </div>
      {actions && <div className="conn-row-actions">{actions}</div>}
    </div>
  );
}
