import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { t } from '../i18n';

function progressBarState(index: number, step: number): string {
  if (index === step) return ' active';
  return index < step ? ' complete' : '';
}

/** The clickable progress bars (one per step) and the "n of m" count. */
export function OnboardingProgress({
  steps,
  step,
  busy,
  onGo,
}: {
  steps: ReadonlyArray<{ id: string; label(): string }>;
  step: number;
  busy: boolean;
  onGo(index: number): void;
}) {
  return (
    <nav aria-label={t('Setup progress')}>
      {steps.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          title={entry.label()}
          className={`onboarding-progress-bar${progressBarState(index, step)}`}
          aria-label={t('Go to step {{step}}: {{label}}', { step: index + 1, label: entry.label() })}
          aria-current={index === step ? 'step' : undefined}
          disabled={busy}
          onClick={() => onGo(index)}
        />
      ))}
      <span className="onboarding-progress-count">
        {t('{{current}} of {{total}}', {
          current: step + 1,
          total: steps.length,
        })}
      </span>
    </nav>
  );
}

/** Skip, Back, and Next — or Finish on the last step, which does exactly what
 *  Skip does: one exit only. */
export function OnboardingFooter({
  step,
  stepCount,
  busy,
  loading,
  onSkip,
  onBack,
  onNext,
  onFinish,
}: {
  step: number;
  stepCount: number;
  busy: boolean;
  loading: boolean;
  onSkip(trigger: HTMLButtonElement): void;
  onBack(): void;
  onNext(): void;
  onFinish(): void;
}) {
  return (
    <footer>
      {step < stepCount - 1 && (
        <button type="button" className="secondary" disabled={busy} onClick={(event) => onSkip(event.currentTarget)}>
          {t('Skip setup')}
        </button>
      )}
      <div>
        {step > 0 && (
          <button type="button" disabled={busy} onClick={onBack}>
            <ArrowLeft size={14} /> {t('Back')}
          </button>
        )}
        {step < stepCount - 1 ? (
          <button type="button" className="primary" disabled={loading || busy} onClick={onNext}>
            {t('Next')} <ArrowRight size={14} />
          </button>
        ) : (
          <button type="button" className="primary" disabled={loading || busy} onClick={onFinish}>
            <Check size={14} /> {t('Finish')}
          </button>
        )}
      </div>
    </footer>
  );
}
