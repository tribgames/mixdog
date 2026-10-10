import { PanelRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DesktopModelSelection } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { ContextUsageIndicator } from './transcript-status';

// ONE translucent capsule pinned to the transcript's top-right corner (user:
// 아이폰 다이나믹 아일랜드 같은 섬). The gauge used to live inside the composer
// footer, where it competed with the input surface for space (user: 채팅
// 입력을 가린다). The capsule frames the context gauge and, when the pane has
// one, the dock toggle.
export function SessionStatusIsland({
  snapshot,
  onInherit,
  dockOpen = false,
  onToggleDock,
}: {
  snapshot: Snapshot;
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
  dockOpen?: boolean;
  onToggleDock?: () => void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const sessionId = String(snapshot.sessionId || '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger that closes the context popover when the session changes
  useEffect(() => setContextOpen(false), [sessionId]);
  return (
    <div className="session-status-island">
      <ContextUsageIndicator
        snapshot={snapshot}
        open={contextOpen}
        onOpenChange={setContextOpen}
        onInherit={onInherit}
      />
      {onToggleDock && (
        <button
          type="button"
          className="session-dock-toggle session-status-dock-toggle"
          aria-pressed={dockOpen}
          aria-label={t(dockOpen ? 'Close {{label}}' : 'Open {{label}}', {
            label: t('utility panel'),
          })}
          data-tooltip={t(dockOpen ? 'Close {{label}}' : 'Open {{label}}', {
            label: t('utility panel'),
          })}
          onClick={() => {
            setContextOpen(false);
            onToggleDock();
          }}
        >
          {/* Island voice is lucide line work (user: 아이콘 크기가 전혀 안 맞아 —
          채워진 거 말고 선으로 된 아이콘): the filled 16px codicon font glyph
          read heavier, brighter and off-size beside the 18px stroke marks. */}
          <PanelRight size={20} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
