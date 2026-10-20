import { Plus } from 'lucide-react';
import { memo, useState } from 'react';

import { t } from './i18n';
import { SidebarPanelAction } from './session-sidebar-sections';
import { CapabilitySettings } from './settings/CapabilitySettings';
import { useSurfaceNavigationReset } from './surface-activity';
import './settings/settings.css';
import './desktop/31-extensions.css';

// The rail's Skills destination: only the user's own skills, in the
// extension list grammar, with the editor and dialogs of the skills panel.
export const SkillsPane = memo(function SkillsPane({ active }: { active: boolean }) {
  const [createOpen, setCreateOpen] = useState(false);
  useSurfaceNavigationReset(active, () => setCreateOpen(false));
  const api = window.mixdogDesktop ?? {};
  return (
    <div
      className="extensions-pane skills-pane schedules-pane stable-surface-preserved stable-takeover-surface"
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
    >
      <div className="schedules-page">
        <SidebarPanelAction
          active={active}
          label={t('Add skill')}
          icon={Plus}
          className="extensions-add"
          onClick={() => setCreateOpen((open) => !open)}
        />
        <CapabilitySettings
          api={api}
          category="user-skills"
          active={active}
          createOpen={createOpen}
          onCreateOpenChange={setCreateOpen}
          portalConfirm
        />
      </div>
    </div>
  );
});
