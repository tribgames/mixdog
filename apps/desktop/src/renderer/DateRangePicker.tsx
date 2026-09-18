/**
 * One date-range picker for the whole app.
 *
 * The native date and time inputs hand their popups to Chromium, which paints
 * its own calendar and clock in its own metrics — a frame that never matched
 * ours (user: 프레임이랑 이런게 너무 우리거랑 안 맞는 느낌). Every pixel here
 * is our own markup, so a range reads like the surface holding it.
 *
 * A range is two clicks. Clocks stay optional: blank means the whole day,
 * which is exactly what a date-only range already meant.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { t, uiFormatLocale } from './i18n';
import { OpenSelect } from './OpenSelect';

export type DayRange = { startDay: string; endDay: string; startTime?: string; endTime?: string };

const WEEKS = 6;
const STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00`);
}

function addDays(day: string, count: number): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + count);
  return dayKey(date);
}

function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function shiftMonth(month: string, count: number): string {
  const date = parseDay(month);
  date.setMonth(date.getMonth() + count, 1);
  return dayKey(date);
}

/** The locale's first column, counted the way `Date#getDay()` counts days.
 *  Korean calendars open on Sunday, most European ones on Monday. */
function weekStart(locale: string): number {
  const info = (new Intl.Locale(locale) as { getWeekInfo?: () => { firstDay?: number } }).getWeekInfo?.();
  return (info?.firstDay ?? 1) % 7;
}

/** Six fixed rows: a month that needs fewer must not resize the panel under
 *  the pointer while stepping through months. */
function monthCells(month: string, start: number): string[] {
  const lead = (parseDay(month).getDay() - start + 7) % 7;
  const origin = addDays(month, -lead);
  return Array.from({ length: WEEKS * 7 }, (_, index) => addDays(origin, index));
}

export function DateRangePicker({
  value,
  maxDay,
  disabled = false,
  onChange,
}: {
  value: DayRange;
  /** Last selectable date. Later days still show, greyed and unpickable. */
  maxDay: string;
  disabled?: boolean;
  onChange: (next: DayRange) => void;
}) {
  const locale = uiFormatLocale();
  const start = useMemo(() => weekStart(locale), [locale]);
  const [month, setMonth] = useState(() => monthOf(value.endDay || maxDay));
  // The first click parks here until the second one lands; until then the grid
  // paints what the pointer is about to select.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const cells = useMemo(() => monthCells(month, start), [month, start]);
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(parseDay(month)),
    [locale, month]
  );
  const weekdayFormat = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short' }), [locale]);
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }),
    [locale]
  );
  const preview = anchor && hover ? [anchor, hover].sort() : null;
  const from = preview ? preview[0] : value.startDay;
  const to = preview ? preview[1] : value.endDay;

  const pick = (day: string) => {
    if (day > maxDay) return;
    if (!anchor) {
      setAnchor(day);
      setHover(day);
      return;
    }
    const [first, last] = anchor <= day ? [anchor, day] : [day, anchor];
    setAnchor(null);
    setHover(null);
    onChange({ ...value, startDay: first, endDay: last });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const day = (event.target as HTMLElement).dataset?.day;
    const step = STEPS[event.key];
    if (!day || !step) return;
    event.preventDefault();
    const next = addDays(day, step);
    setMonth(monthOf(next));
    queueMicrotask(() => grid.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus());
  };

  const hours = [
    { value: '', label: t('All day') },
    ...Array.from({ length: 24 }, (_, hour) => ({ value: pad2(hour), label: pad2(hour) })),
  ];
  const minutes = Array.from({ length: 12 }, (_, index) => ({ value: pad2(index * 5), label: pad2(index * 5) }));

  const clock = (edge: 'startTime' | 'endTime') => {
    const text = value[edge] || '';
    const write = (next?: string) => onChange({ ...value, [edge]: next });
    return (
      <div className="mx-daterange-clock">
        <span>{edge === 'startTime' ? t('Start time') : t('End time')}</span>
        <OpenSelect
          ariaLabel={t('Hour')}
          className="mx-daterange-unit"
          options={hours}
          value={text.slice(0, 2)}
          disabled={disabled}
          localizeLabels={false}
          onChange={(hour) => write(hour ? `${hour}:${text.slice(3, 5) || '00'}` : undefined)}
        />
        <OpenSelect
          ariaLabel={t('Minute')}
          className="mx-daterange-unit"
          options={minutes}
          value={text.slice(3, 5) || '00'}
          disabled={disabled || !text}
          localizeLabels={false}
          onChange={(minute) => write(`${text.slice(0, 2)}:${minute}`)}
        />
      </div>
    );
  };

  return (
    <div className="mx-daterange">
      <header className="mx-daterange-head">
        <button
          type="button"
          className="mx-daterange-step"
          aria-label={t('Previous month')}
          title={t('Previous month')}
          disabled={disabled}
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <strong data-i18n-skip="">{monthLabel}</strong>
        <button
          type="button"
          className="mx-daterange-step"
          aria-label={t('Next month')}
          title={t('Next month')}
          disabled={disabled || monthOf(maxDay) <= month}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </header>
      <div className="mx-daterange-weekdays" aria-hidden="true">
        {cells.slice(0, 7).map((day) => (
          <span key={day} data-i18n-skip="">
            {weekdayFormat.format(parseDay(day))}
          </span>
        ))}
      </div>
      <div
        className="mx-daterange-grid"
        ref={grid}
        role="grid"
        onKeyDown={onKeyDown}
        onMouseLeave={() => setHover(anchor)}
      >
        {cells.map((day) => {
          const selected = Boolean(from && to) && day >= from && day <= to;
          return (
            <button
              key={day}
              type="button"
              className="mx-daterange-day"
              data-day={day}
              data-outside={day.slice(0, 7) === month.slice(0, 7) ? undefined : ''}
              data-range={
                selected ? (day === from ? (day === to ? 'only' : 'start') : day === to ? 'end' : 'inside') : undefined
              }
              aria-label={dayFormat.format(parseDay(day))}
              aria-pressed={selected}
              disabled={disabled || day > maxDay}
              tabIndex={day === from ? 0 : -1}
              onMouseEnter={() => anchor && setHover(day)}
              onFocus={() => anchor && setHover(day)}
              onClick={() => pick(day)}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
      {clock('startTime')}
      {clock('endTime')}
    </div>
  );
}