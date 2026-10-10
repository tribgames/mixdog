/**
 * Period chips, the custom-range editor hanging off its chip, and the
 * previous/next arrows around the served period. Token usage and
 * subscription usage page through their periods the same way; each passes its
 * own chips and loads whatever a chip or an arrow asks for.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DateRangePicker, type DayRange } from './DateRangePicker';
import { t } from './i18n';
import { localDayKey, shiftCustomRange, type Row } from './usage-stats-model';

type PeriodOption = { key: string; label: string };

/** The calendar chips both usage modes offer. */
export function usagePeriodOptions(): PeriodOption[] {
  return [
    { key: 'hour', label: t('Last 24 hours') },
    { key: '7d', label: t('Last 7 days') },
    { key: 'day', label: t('Last 30 days') },
    { key: 'week', label: t('Last 90 days') },
    { key: 'month', label: t('Last year') },
    { key: 'year', label: t('All') },
    { key: 'custom', label: t('Custom') },
  ];
}

export function UsagePeriodControls({
  views,
  view,
  period,
  periodText,
  firstDay,
  today,
  fallback,
  waiting,
  paged,
  onLoad,
  leading,
}: {
  /** What the period applies to. It takes the served period's row, and the
   *  chips move to a row of their own below it. */
  leading?: ReactNode;
  views: ReadonlyArray<PeriodOption>;
  /** The view the served period belongs to. */
  view: string;
  period: Row;
  periodText: string;
  /** First recorded day: the custom editor's seed for the all-history view. */
  firstDay: string;
  today: string;
  /** The range the custom editor starts from before any period was served. */
  fallback: { fromMs: number; toMs: number };
  waiting: boolean;
  paged: boolean;
  onLoad: (view: string, anchor?: string, dates?: DayRange) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  // Editing a custom range selects its tab without replacing the applied data.
  const activeView = customOpen ? 'custom' : view;
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  // Clock times stay optional: empty fields keep the whole selected days.
  const [customStartTime, setCustomStartTime] = useState('');
  const [customEndTime, setCustomEndTime] = useState('');
  const [applied, setApplied] = useState<DayRange | null>(null);
  const customHost = useRef<HTMLDivElement>(null);
  // The editor hangs off its chip as a popover, so it dismisses like one.
  useEffect(() => {
    if (!customOpen) return undefined;
    // Its clock pickers portal their open menus to document.body: a pick there
    // is still inside the editor, and the first Escape closes only the menu.
    const openMenus = () =>
      Array.from(
        customHost.current?.querySelectorAll('[role="combobox"][aria-expanded="true"][aria-controls]') || []
      ).flatMap((trigger) => {
        const menu = document.getElementById(trigger.getAttribute('aria-controls') || '');
        return menu ? [menu] : [];
      });
    const dismiss = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && customHost.current?.contains(target)) return;
      if (target && openMenus().some((menu) => menu.contains(target))) return;
      setCustomOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !openMenus().length) setCustomOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [customOpen]);
  const seedCustomRange = (range: DayRange) => {
    setCustomStart(range.startDay);
    setCustomEnd(range.endDay);
    setCustomStartTime(range.startTime || '');
    setCustomEndTime(range.endTime || '');
  };
  const applyCustom = (range: DayRange) => {
    setApplied(range);
    seedCustomRange(range);
    setCustomOpen(false);
    onLoad('custom', undefined, range);
  };
  // A page step measures the SELECTION, never the served period: a range
  // reaching into the present day is served clamped back to "now".
  const customApplied = view === 'custom' ? applied : null;
  const previousRange = customApplied ? shiftCustomRange(customApplied, -1) : null;
  const nextRange = customApplied ? shiftCustomRange(customApplied, 1) : null;
  const canPrevious = customApplied
    ? Boolean(previousRange && previousRange.startDay >= '1970-01-01')
    : Boolean(period.previousAnchor);
  const canNext = customApplied ? Boolean(nextRange && nextRange.endDay <= today) : Boolean(period.nextAnchor);
  const page = (direction: 1 | -1) => {
    const target = direction === -1 ? previousRange : nextRange;
    if (target) applyCustom(target);
    else onLoad(view, String(direction === -1 ? period.previousAnchor : period.nextAnchor));
  };
  const openCustom = () => {
    const seed = customApplied || {
      startDay: String(period.startDay || firstDay || localDayKey(fallback.fromMs)),
      endDay: String(period.endDay || localDayKey(fallback.toMs)),
    };
    seedCustomRange(seed);
    setCustomOpen(true);
  };
  // Times only ever narrow a range, so a reversed clock can only appear when
  // both ends name the same day.
  const customInvalid =
    !customStart ||
    !customEnd ||
    customStart > customEnd ||
    (customStart === customEnd &&
      Boolean(customStartTime) &&
      Boolean(customEndTime) &&
      customStartTime > customEndTime);
  const customRange: DayRange = {
    startDay: customStart,
    endDay: customEnd,
    ...(customStartTime ? { startTime: customStartTime } : {}),
    ...(customEndTime ? { endTime: customEndTime } : {}),
  };
  const chips = (
    // biome-ignore lint/a11y/useSemanticElements: chip group is a div styled by .stats-ranges; a fieldset would change the DOM
    <div className="stats-ranges" role="group" aria-label={t('Period')}>
      {views.map((option) => {
        const chip = (
          <button
            key={option.key}
            type="button"
            className={`stats-range ${option.key === activeView ? 'is-active' : ''}`}
            aria-pressed={option.key === activeView}
            disabled={waiting}
            aria-expanded={option.key === 'custom' ? customOpen : undefined}
            onClick={() => {
              if (option.key === 'custom') {
                if (customOpen) setCustomOpen(false);
                else openCustom();
              } else {
                setCustomOpen(false);
                if (option.key !== view) onLoad(option.key);
              }
            }}
          >
            {option.label}
          </button>
        );
        if (option.key !== 'custom') return chip;
        return (
          <div className="stats-custom" key={option.key} ref={customHost}>
            {chip}
            {customOpen && (
              <form
                className="stats-custom-range"
                aria-label={t('Custom')}
                onSubmit={(event) => {
                  event.preventDefault();
                  applyCustom(customRange);
                }}
              >
                <DateRangePicker value={customRange} maxDay={today} disabled={waiting} onChange={seedCustomRange} />
                <button className="stats-range" type="submit" disabled={waiting || customInvalid}>
                  {t('Apply')}
                </button>
              </form>
            )}
          </div>
        );
      })}
    </div>
  );
  const pager = (
    <div className="stats-period">
      {paged && (
        <button
          type="button"
          className="stats-period-arrow"
          aria-label={t('Previous period')}
          title={t('Previous period')}
          disabled={waiting || !canPrevious}
          onClick={() => page(-1)}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      )}
      <span className="stats-period-label">{periodText}</span>
      {paged && (
        <button
          type="button"
          className="stats-period-arrow"
          aria-label={t('Next period')}
          title={t('Next period')}
          disabled={waiting || !canNext}
          onClick={() => page(1)}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      )}
    </div>
  );
  if (!leading) {
    return (
      <div className="stats-controls">
        {chips}
        {pager}
      </div>
    );
  }
  return (
    <>
      <div className="stats-controls">
        {leading}
        {pager}
      </div>
      <div className="stats-controls">{chips}</div>
    </>
  );
}
