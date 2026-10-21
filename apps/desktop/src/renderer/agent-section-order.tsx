// The Bots page's sections (Bots, Rooms, Agents; Mixy stays first inside
// Bots) in the shared stored order (bot-order-store), separated by hairlines.
// The sections carry no heading row; rows reorder by dragging the rows themselves.
import type React from 'react';
import { Fragment } from 'react';
import type { PaneSectionId } from './bot-order-store';
import { t } from './i18n';
import './agent-section-order.css';

/** What each section is called. The Working block and the Leads belong to
 *  "Agents" (both list agents at work); "Rooms" are the group rooms. */
export const sectionLabel = (id: PaneSectionId): string =>
  id === 'bots' ? t('Bots') : id === 'rooms' ? t('Rooms') : t('Agents');

/** The Bots page's sections in their stored order, one hairline between
 *  present sections. Empty or hidden sections keep their slot. */
export function ArrangedSections({
  order,
  present,
  blocks,
}: {
  order: readonly PaneSectionId[];
  present: Readonly<Record<PaneSectionId, boolean>>;
  /** A section's body; the hairline above a section is drawn here, so `divider` is always false. */
  blocks: Record<PaneSectionId, (divider: boolean) => React.ReactNode>;
}) {
  let seen = false;
  return order.map((id) => {
    if (!present[id]) return <Fragment key={id}>{blocks[id](false)}</Fragment>;
    const divider = seen;
    seen = true;
    return (
      <Fragment key={id}>
        {divider &&
          id !== 'agents' &&
          (id === 'rooms' ? (
            <hr className="agent-chat-divider agent-room-section-divider" aria-label={t('Group rooms')} />
          ) : (
            <hr className="agent-chat-divider" role="presentation" />
          ))}
        <div className="agent-section" data-section-id={id}>
          {blocks[id](divider && id === 'agents')}
        </div>
      </Fragment>
    );
  });
}
