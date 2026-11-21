import { useEffect, useId, useRef, useState, type RefObject } from 'react';
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

function stopCopy(card: ComposerQuotaCardModel): { title: string; guidance: string } {
  if (card.kind === 'entitlement') {
    return {
      title: t('Not included in your plan'),
      guidance: t('Upgrade your plan, or choose another model or provider.'),
    };
  }
  if (card.kind === 'billing') {
    return {
      title: t('Out of credits or at spend limit'),
      guidance: t('Check your billing with the provider, then try again.'),
    };
  }
  return {
    title: t('Usage limit reached'),
    guidance: card.otherAccount
      ? t("Switch accounts or to another provider's model to continue now")
      : t("Switch to another provider's model to continue now"),
  };
}

function resumeCopy(card: ComposerQuotaCardModel, time: string, stopGuidance: string) {
  if (card.reserved) {
    return {
      guidance: t('Resume reserved · click to cancel'),
      buttonLabel: t('Cancel resume'),
      buttonIcon: 'loading' as const,
      buttonAction: card.onToggleResume,
    };
  }
  if (card.onResume) {
    return {
      guidance: t('Continue from where you left off.'),
      buttonLabel: t('Resume with changed model'),
      buttonIcon: 'play' as const,
      buttonAction: card.onResume,
    };
  }
  return {
    guidance: stopGuidance,
    buttonLabel: t('Resume at {{time}}', { time }),
    buttonIcon: 'clock' as const,
    buttonAction: card.onToggleResume,
  };
}

function useGuidanceOverflow(guideRef: RefObject<HTMLSpanElement | null>, watched: readonly unknown[]): boolean {
  const [hidden, setHidden] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the watched values change the guidance text, so the overflow must be re-measured.
  useEffect(() => {
    const guide = guideRef.current;
    if (!guide) return undefined;
    const measure = () => setHidden(guide.scrollWidth > guide.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(guide);
    return () => observer.disconnect();
  }, [guideRef, ...watched]);
  return hidden;
}

/** The quota stop as one pill line between the island and the prompt input; it has no close and leaves with the stop. */
export function ComposerQuotaCard({ card }: { card: ComposerQuotaCardModel }) {
  const remaining = useQuotaRemaining(card.resetAt);
  const time = card.resetAt === null ? '' : quotaResetLabel(card.resetAt);
  const resumeNow = Boolean(card.onResume && !card.reserved);
  const { title, guidance: stopGuidance } = stopCopy(card);
  const { guidance, buttonLabel, buttonIcon, buttonAction } = resumeCopy(card, time, stopGuidance);
  const guidanceId = useId();
  const guideRef = useRef<HTMLSpanElement>(null);
  const guidanceHidden = useGuidanceOverflow(guideRef, [guidance, time, remaining]);
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
