import { useQuotaRemaining } from './ComposerIsland';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { quotaResetLabel } from './quota-continue';

/** The provider's quota ran out and stopped the latest turn. */
export type ComposerQuotaCardModel = {
  /** Provider display name. */
  provider: string;
  /** Epoch ms the quota resets; null when unknown. */
  resetAt: number | null;
  /** A model switch of this chat is in flight: every action waits. */
  busy: boolean;
  /** Resume this chat at the reset time; given only with a known reset. */
  onWait?(): void;
  /** Pick another model for this chat, then retry the stopped turn. */
  onSwitch(): void;
  /** Close the card for this stopped turn. */
  onDismiss(): void;
};

/**
 * The quota stop offer between the island and the prompt input: wait for the
 * reset, or switch this chat to another model and continue right away.
 */
export function ComposerQuotaCard({ card }: { card: ComposerQuotaCardModel }) {
  const remaining = useQuotaRemaining(card.resetAt);
  const time = card.resetAt === null ? '' : quotaResetLabel(card.resetAt);
  return (
    <section className="composer-quota-card" aria-label={t('Usage limit reached')}>
      <div className="composer-island-pbody">
        <p className="composer-island-ptitle">
          <MxIcon name="warning" size={16} />
          {t('{{provider}} usage limit reached', { provider: card.provider })}
        </p>
        {card.resetAt !== null ? (
          <p className="composer-island-pnote">{t('Resets at {{time}} · {{remaining}} left.', { time, remaining })}</p>
        ) : null}
        <div className="composer-island-pfoot">
          {card.onWait && card.resetAt !== null ? (
            <button type="button" className="composer-island-button" disabled={card.busy} onClick={card.onWait}>
              {t('Resume at {{time}}', { time })}
            </button>
          ) : null}
          <button
            type="button"
            className="composer-island-button composer-island-button-primary"
            disabled={card.busy}
            onClick={card.onSwitch}
          >
            {t('Switch model')}
          </button>
        </div>
      </div>
      <button type="button" className="composer-quota-card-close" aria-label={t('Close')} onClick={card.onDismiss}>
        <MxIcon name="close-small" size={14} />
      </button>
    </section>
  );
}
