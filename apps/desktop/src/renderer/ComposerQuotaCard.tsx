import { useEffect, useId, useRef, useState } from 'react';
import { useQuotaRemaining } from './ComposerIsland';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { quotaResetLabel } from './quota-continue';

/** The provider's quota ran out and stopped the latest turn. */
export type ComposerQuotaCardModel = {
  /** What stopped the turn; absent means an exhausted quota. */
  kind?: 'quota_exhausted' | 'entitlement' | 'billing';
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
  onResume?(): void;
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
  const resumeNow = Boolean(card.onResume && !card.reserved);
  const title =
    card.kind === 'entitlement'
      ? t('Not included in your plan')
      : card.kind === 'billing'
        ? t('Out of credits or at spend limit')
        : t('Usage limit reached');
  let guidance =
    card.kind === 'entitlement'
      ? t('Upgrade your plan, or choose another model or provider.')
      : card.kind === 'billing'
        ? t('Check your billing with the provider, then try again.')
        : card.otherAccount
          ? t("Switch accounts or to another provider's model to continue now")
          : t("Switch to another provider's model to continue now");
  let buttonLabel = t('Resume at {{time}}', { time });
  let buttonIcon: 'clock' | 'loading' | 'play' = 'clock';
  let buttonAction = card.onToggleResume;
  if (card.reserved) {
    guidance = t('Resume reserved · click to cancel');
    buttonLabel = t('Cancel resume');
    buttonIcon = 'loading';
  } else if (resumeNow) {
    guidance = t('Continue from where you left off.');
    buttonLabel = t('Resume with changed model');
    buttonIcon = 'play';
    buttonAction = card.onResume;
  }
  const guidanceId = useId();
  const guideRef = useRef<HTMLSpanElement>(null);
  const [guidanceHidden, setGuidanceHidden] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: guidance, time and remaining change the guidance text, so the overflow must be re-measured.
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
      aria-label={title}
      aria-describedby={guidanceHidden ? guidanceId : undefined}
      title={guidanceHidden ? guidance : undefined}
      data-guidance-hidden={guidanceHidden ? 'true' : undefined}
    >
      <MxIcon name="warning" size={16} className="composer-quota-card-icon" aria-hidden="true" />
      <div className="composer-quota-card-text">
        <strong className="composer-quota-card-title">{title}</strong>
        {time ? <span className="composer-quota-card-reset">{t('· {{remaining}} left', { remaining })}</span> : null}
        <span className="composer-quota-card-guide" ref={guideRef}>
          <span aria-hidden="true">· </span>
          <span id={guidanceId}>{guidance}</span>
        </span>
      </div>
      {card.onResume || (card.onToggleResume && (card.reserved || time)) ? (
        <button
          type="button"
          className="composer-island-button composer-island-button-primary composer-quota-card-resume"
          aria-pressed={resumeNow ? undefined : card.reserved}
          data-reserved={card.reserved ? 'true' : undefined}
          disabled={card.busy}
          title={card.reserved ? t('Resume reserved · click to cancel') : undefined}
          onClick={buttonAction}
        >
          <MxIcon name={buttonIcon} size={14} className="composer-quota-card-resume-icon" aria-hidden="true" />
          {buttonLabel}
        </button>
      ) : null}
    </section>
  );
}
