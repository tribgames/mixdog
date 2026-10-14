import { useEffect, useId, useRef, useState } from 'react';
import { useQuotaRemaining } from './ComposerIsland';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { quotaResetLabel } from './quota-continue';

/** The provider's quota ran out and stopped the latest turn. */
export type ComposerQuotaCardModel = {
  /** Epoch ms the quota resets; null when unknown. */
  resetAt: number | null;
  /** The exhausted provider sends from a manually picked account and has
   *  another signed-in one to switch to. */
  otherAccount: boolean;
  /** A resume at the reset is reserved: the button spins. */
  reserved: boolean;
  /** A reserve/cancel request is in flight. */
  busy: boolean;
  /** Reserve or cancel the resume at the reset; given only with a known reset. */
  onToggleResume?(): void;
};

/**
 * The quota stop as one pill line between the island and the prompt input:
 * what happened, when it resets, how to continue now, and resuming at the
 * reset. It has no close: it leaves with the stop itself. When the guidance
 * does not fit the line it is hidden and kept as the tooltip and accessible
 * description; everything else always stays on the line.
 */
export function ComposerQuotaCard({ card }: { card: ComposerQuotaCardModel }) {
  const remaining = useQuotaRemaining(card.resetAt);
  const time = card.resetAt === null ? '' : quotaResetLabel(card.resetAt);
  const guidance = card.otherAccount
    ? t("Switch accounts or to another provider's model to continue now")
    : t("Switch to another provider's model to continue now");
  const guidanceId = useId();
  const guideRef = useRef<HTMLSpanElement>(null);
  const [guidanceHidden, setGuidanceHidden] = useState(false);
  useEffect(() => {
    const guide = guideRef.current;
    if (!guide) return undefined;
    // Only the guidance shrinks; hidden, it keeps its box, so the
    // measurement stays stable.
    const measure = () => setGuidanceHidden(guide.scrollWidth > guide.clientWidth);
    measure();
    // Test DOMs have no observer; they only need the first measurement.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(guide);
    return () => observer.disconnect();
  }, [guidance, time, remaining]);
  return (
    <section
      className="composer-quota-card"
      aria-label={t('Usage limit reached')}
      aria-describedby={guidanceHidden ? guidanceId : undefined}
      title={guidanceHidden ? guidance : undefined}
      data-guidance-hidden={guidanceHidden ? 'true' : undefined}
    >
      <MxIcon name="warning" size={16} className="composer-quota-card-icon" aria-hidden="true" />
      <div className="composer-quota-card-text">
        <strong className="composer-quota-card-title">{t('Usage limit reached')}</strong>
        {time ? (
          <span className="composer-quota-card-reset">{t('· {{remaining}} left', { remaining })}</span>
        ) : null}
        <span className="composer-quota-card-guide" ref={guideRef}>
          <span aria-hidden="true">· </span>
          <span id={guidanceId}>{guidance}</span>
        </span>
      </div>
      {card.onToggleResume && time ? (
        <button
          type="button"
          className="composer-island-button composer-island-button-primary composer-quota-card-resume"
          aria-pressed={card.reserved}
          data-reserved={card.reserved ? 'true' : undefined}
          disabled={card.busy}
          title={card.reserved ? t('Resume reserved · click to cancel') : undefined}
          onClick={card.onToggleResume}
        >
          <MxIcon
            name={card.reserved ? 'loading' : 'clock'}
            size={14}
            className="composer-quota-card-resume-icon"
            aria-hidden="true"
          />
          {t('Resume at {{time}}', { time })}
        </button>
      ) : null}
    </section>
  );
}
