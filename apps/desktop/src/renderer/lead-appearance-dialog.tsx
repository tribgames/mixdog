// "Appearance" of the Leads: the bots' own pixel-face picker (kind, accessory,
// colour) over the one face every Lead row wears. A pick applies at once.
import { X } from 'lucide-react';
import { useId } from 'react';
import { AgentAvatar, AgentAvatarPicker } from './agent-avatar';
import { t } from './i18n';
import { setLeadAvatar, useLeadAvatar } from './lead-avatar-store';
import './lead-appearance.css';
import { SidebarDialogLayer } from './sidebar-dialog';

export function LeadAppearanceDialog({ onClose }: { onClose(): void }) {
  const titleId = useId();
  const avatar = useLeadAvatar();
  return (
    <SidebarDialogLayer onClose={onClose}>
      <section
        className="schedules-dialog agent-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-lead-appearance="true"
      >
        <header>
          <h2 id={titleId}>{t('Appearance')}</h2>
          <div className="schedules-dialog-header-actions">
            <button type="button" aria-label={t('Close')} onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <form onSubmit={(event) => event.preventDefault()}>
          <div className="agent-create-body">
            <div className="lead-appearance-hero">
              <span className="lead-appearance-face">
                <AgentAvatar agentId="lead" avatar={avatar} className="agent-contact-mascot" />
              </span>
              <b>{t('Leads')}</b>
            </div>
            <section className="agent-create-section">
              <AgentAvatarPicker value={avatar} onChange={setLeadAvatar} />
            </section>
          </div>
          <footer>
            <button type="button" className="secondary" onClick={() => setLeadAvatar(null)}>
              {t('Reset')}
            </button>
            <button type="button" onClick={onClose}>
              {t('Close')}
            </button>
          </footer>
        </form>
      </section>
    </SidebarDialogLayer>
  );
}
