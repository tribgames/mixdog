/**
 * The subscription meter as a line over the selected period: what it read,
 * each model's share stacked as a coloured area under it, the stretches
 * nobody measured, the forecast to run-out and an even-pace diagonal, the
 * time still to come shaded, with one hover card per time slot.
 * The plot is a stretched viewBox with non-scaling strokes; every label is
 * HTML laid over it, so text never stretches with the plot.
 */
import { curveMonotoneX, line as pathLine } from 'd3-shape';
import { useId, type CSSProperties } from 'react';
import { t, uiFormatLocale } from './i18n';
import { modelDisplayName } from './provider-display';
import { quotaClock, quotaPercent, quotaValue, quotaValueBreakdown, quotaValueCaution } from './quota-usage-model';
import { record, rows } from './record-utils';
import { TrendDetailCard, useTrendDetail } from './trend-detail';
import { statsNumber, statsTokens, trendPeriodLabel, type Row } from './usage-stats-model';

const WIDTH = 1000;
const HEIGHT = 100;
// Path vertex kinds from the ledger: pen up, measured, unmeasured.
const MOVE = 0;
const MEASURED = 1;
const UNMEASURED = 2;
// Past this many windows in view, per-window peak labels would collide.
const PEAK_LABEL_LIMIT = 12;
// Axis ticks sit on the clock's own boundaries, at the finest step that keeps
// them at most AXIS_TICKS. A label closer than these shares of the width to
// an edge, or to the now mark, would run off the chart or into that mark.
const AXIS_TICKS = 7;
const AXIS_EDGE = 0.02;
const AXIS_NOW_GAP = 0.06;
type AxisUnit = 'hour' | 'day' | 'month';
type AxisStep = { unit: AxisUnit; size: number };
const AXIS_STEPS: AxisStep[] = [
  ...[1, 2, 3, 6, 12].map((size) => ({ unit: 'hour' as const, size })),
  ...[1, 2, 7, 14].map((size) => ({ unit: 'day' as const, size })),
  ...[1, 2, 3, 6, 12].map((size) => ({ unit: 'month' as const, size })),
];
const AXIS_FORMATS: Record<AxisUnit, Intl.DateTimeFormatOptions> = {
  hour: { hour: '2-digit', minute: '2-digit' },
  day: { month: 'short', day: 'numeric' },
  month: { month: 'short' },
};

type Point = [number, number, number];
type LegendItem = { key: string; label: string; series: string };

function pointList(value: unknown): Point[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    Array.isArray(entry) && entry.length >= 2
      ? [[statsNumber(entry[0]), statsNumber(entry[1]), statsNumber(entry[2])] as Point]
      : []
  );
}

const coordinate = (value: number) => value.toFixed(1);

// The meters report whole percents: a rise of one step is the reading
// catching up with use that went on through the hold before it.
const METER_STEP = 1;

/** The meter without the holds that end in a one-step rise: each reading
 *  runs straight on to the next instead of sitting flat and then jumping, so
 *  the line climbs instead of stair-stepping (user: 차트선이 너무 안 이쁜데). */
function smoothMeter(points: Point[]): Point[] {
  const kept: Point[] = [];
  let hold: Point | null = null;
  for (const point of points) {
    const last = kept.at(-1);
    if (last && point[2] === MEASURED && point[1] === last[1]) {
      hold = point;
      continue;
    }
    if (hold) {
      const rise = point[1] - hold[1];
      if (!(point[2] === MEASURED && rise > 0 && rise <= METER_STEP)) kept.push(hold);
      hold = null;
    }
    kept.push(point);
  }
  if (hold) kept.push(hold);
  return kept;
}

type Vertex = [number, number, number];
type Run = { kind: number; curve: boolean; coords: Array<[number, number]> };

const curved = pathLine().curve(curveMonotoneX).digits(1);
const straight = pathLine().digits(1);

/** A pen-down stretch as runs sharing their ends: measured stretches curve
 *  through their vertices without overshooting them; gaps and same-instant
 *  drops stay straight. */
function runsOf(vertices: Vertex[]): Run[] {
  const runs: Run[] = [];
  for (let index = 1; index < vertices.length; index += 1) {
    const [fromX, fromY] = vertices[index - 1];
    const [toX, toY, mark] = vertices[index];
    const kind = mark === UNMEASURED ? UNMEASURED : MEASURED;
    const curve = kind === MEASURED && toX > fromX;
    const last = runs.at(-1);
    if (last && last.kind === kind && last.curve === curve) last.coords.push([toX, toY]);
    else
      runs.push({
        kind,
        curve,
        coords: [
          [fromX, fromY],
          [toX, toY],
        ],
      });
  }
  return runs;
}

const draw = (run: Run) => (run.curve ? curved : straight)(run.coords) ?? '';
/** Runs joined into one continuous edge. */
const edge = (runs: Run[]) => runs.map((run, index) => (index ? `L${draw(run).slice(1)}` : draw(run))).join('');
const reversed = (runs: Run[]) => [...runs].reverse().map((run) => ({ ...run, coords: [...run.coords].reverse() }));

/** The measured and unmeasured strokes through `upper` and the area down to
 *  `lower`, both read at the times and pen marks of `list`. */
function meterPaths(
  list: Point[],
  x: (time: number) => number,
  y: (value: number) => number,
  upper: number[],
  lower: number[]
) {
  let measured = '';
  let unmeasured = '';
  let area = '';
  let start = 0;
  for (let end = 1; end <= list.length; end += 1) {
    if (end < list.length && list[end][2] !== MOVE) continue;
    const from = start;
    const at = (values: number[]) =>
      list.slice(from, end).map((point, index): Vertex => [x(point[0]), y(values[from + index]), point[2]]);
    const top = runsOf(at(upper));
    for (const run of top) {
      if (run.kind === UNMEASURED) unmeasured += draw(run);
      else measured += draw(run);
    }
    if (top.length) area += `${edge(top)}L${edge(reversed(runsOf(at(lower)))).slice(1)}Z`;
    start = end;
  }
  return { measured, unmeasured, area };
}

/** A polyline's value at `time`, held flat past either end. */
function lineValue(list: Array<[number, number]>, time: number): number {
  const next = list.findIndex(([at]) => at >= time);
  if (next <= 0) return list[next < 0 ? list.length - 1 : 0][1];
  const [fromTime, fromValue] = list[next - 1];
  const [toTime, toValue] = list[next];
  if (toTime === fromTime) return toValue;
  return fromValue + ((toValue - fromValue) * (time - fromTime)) / (toTime - fromTime);
}

/** A model's share at `time`: nothing before its first reading, then its line. */
function shareAt(list: Array<[number, number]>, time: number): number {
  return !list.length || time < list[0][0] ? 0 : lineValue(list, time);
}

/** The instants in [from, to) on a step's boundaries — whole hours, local
 *  midnights or month starts, hours and months on multiples of the step —
 *  stopping once there are more than `limit`. */
function stepTicks(from: number, to: number, step: AxisStep, limit = Number.POSITIVE_INFINITY): number[] {
  const date = new Date(from);
  if (step.unit === 'month') date.setDate(1);
  if (step.unit !== 'hour') date.setHours(0);
  date.setMinutes(0, 0, 0);
  const advance = (count: number) => {
    if (step.unit === 'hour') date.setHours(date.getHours() + count);
    else if (step.unit === 'day') date.setDate(date.getDate() + count);
    else date.setMonth(date.getMonth() + count);
  };
  if (date.getTime() < from) advance(1);
  const phase = () => {
    if (step.unit === 'hour') return date.getHours();
    if (step.unit === 'month') return date.getMonth();
    return 0;
  };
  while (phase() % step.size) advance(1);
  const times: number[] = [];
  for (; date.getTime() < to && times.length <= limit; advance(step.size)) times.push(date.getTime());
  return times;
}

/** The axis of [from, to): the finest step with at most AXIS_TICKS ticks. */
function axisTicks(from: number, to: number): { unit: AxisUnit; times: number[] } {
  for (const step of AXIS_STEPS) {
    const times = stepTicks(from, to, step, AXIS_TICKS);
    if (times.length <= AXIS_TICKS) return { unit: step.unit, times };
  }
  const widest = AXIS_STEPS[AXIS_STEPS.length - 1];
  return { unit: widest.unit, times: stepTicks(from, to, widest) };
}

export function QuotaTrend({
  data,
  provider,
  windowView,
  seriesInk,
  loading,
}: {
  data: Row;
  provider: string;
  windowView: boolean;
  /** A model's chart ink: its rank in the period, shared with the mix. */
  seriesInk: (model: string) => string;
  loading: boolean;
}) {
  const detail = useTrendDetail([data]);
  const areaFill = useId();
  const domain = record(data.domain);
  const from = statsNumber(domain.fromMs);
  const to = Math.max(from + 1, statsNumber(domain.toMs));
  const span = to - from;
  const now = statsNumber(data.generatedAt) || Date.now();
  const points = pointList(data.points);
  const focus = record(data.focus);
  const forecast = record(data.forecast);
  const slots = rows(data.slots);
  const active = slots.find((slot) => String(slot.fromMs) === detail.activeKey);
  // Codex meters can pass 100 %; the scale follows them instead of clipping.
  const top = Math.ceil(points.reduce((max, point) => Math.max(max, point[1]), 100) / 10) * 10;
  const x = (time: number) => ((time - from) / span) * WIDTH;
  const y = (value: number) => HEIGHT - (Math.min(top, Math.max(0, value)) / top) * HEIGHT;
  const left = (time: number) => `${(x(time) / WIDTH) * 100}%`;
  const line = (list: Array<[number, number]>) =>
    list.map(([time, value], index) => `${index ? 'L' : 'M'}${coordinate(x(time))},${coordinate(y(value))}`).join('');
  const meter = smoothMeter(points);
  const paths = meterPaths(
    meter,
    x,
    y,
    meter.map((point) => point[1]),
    meter.map(() => 0)
  );
  const resetAt = statsNumber(focus.resetAt);
  const runsOutAt = statsNumber(forecast.exhaustAt);
  const runsOutLabel = runsOutAt ? t('Runs out {{time}}', { time: quotaClock(runsOutAt, now) }) : '';
  let forecastLine: Array<[number, number]> = [];
  if (windowView && statsNumber(forecast.fromMs) && resetAt) {
    const start: [number, number] = [statsNumber(forecast.fromMs), statsNumber(forecast.fromPct)];
    // A run-out ends the forecast on the limit line, which carries on alone.
    forecastLine = runsOutAt ? [start, [runsOutAt, 100]] : [start, [resetAt, statsNumber(forecast.atResetPct)]];
  }
  const forecastPath = forecastLine.length ? line(forecastLine) : '';
  const pacePath =
    windowView && focus.paced === true && resetAt
      ? line([
          [statsNumber(focus.startMs), 0],
          [statsNumber(focus.endMs), 100],
        ])
      : '';
  const exhaustedAt = statsNumber(focus.exhaustedAt);
  let marker: { time: number; label: string } | null = null;
  if (windowView && exhaustedAt) {
    marker = { time: exhaustedAt, label: t('Maxed out {{time}}', { time: quotaClock(exhaustedAt, now) }) };
  } else if (windowView && runsOutAt) {
    marker = { time: runsOutAt, label: runsOutLabel };
  }
  // The slot running now has been read only up to now; the forecast carries
  // it on to the slot's end.
  const activeEnd = statsNumber(active?.toMs);
  const activeRunning = now < activeEnd;
  const activeForecast = activeRunning && forecastLine.length ? lineValue(forecastLine, activeEnd) : null;
  const activeUsed = `${quotaPercent(active?.startPct)} → ${quotaPercent(active?.endPct)}`;
  const nowX = now > from && now < to ? x(now) : null;
  const peaks = windowView
    ? []
    : rows(data.peaks).filter(
        (row) => statsNumber(row.peak) > 0 && statsNumber(row.peakAt) >= from && statsNumber(row.peakAt) <= to
      );
  // Each model's share is stacked on the ones before it, so the layers fill
  // the area under the meter by model and their top edge is the meter itself
  // (user: 모델별로 영역 색칠하는 스타일로, 모델별 합계 따로 가지 말고).
  // Every model's line runs up to now, and so do the layers.
  const models = rows(data.modelSeries).map((entry) => {
    const key = String(entry.key ?? '');
    return {
      key,
      ink: key ? seriesInk(key) : 'outside',
      label: key ? modelDisplayName(key, provider) : t('Outside Mixdog'),
      list: pointList(entry.points).map(([time, value]): [number, number] => [time, value]),
    };
  });
  // The models are read sparsely and the meter densely, so the layers are
  // stacked at the meter's own vertices with each one's shares scaled to the
  // meter there: the stack's top IS the meter line, curve for curve, and the
  // layer edges bend with it (user: 좀 안 이쁜데).
  const modelEnd = Math.max(0, ...models.map((entry) => entry.list.at(-1)?.[0] ?? 0));
  const stackPoints = meter.filter(([time]) => time <= modelEnd);
  // The layers run on to the models' last reading, the meter held there.
  const stackTail = stackPoints.at(-1);
  if (stackTail && stackTail[0] < modelEnd) {
    const held = lineValue(
      meter.map(([time, value]): [number, number] => [time, value]),
      modelEnd
    );
    stackPoints.push([modelEnd, held, MEASURED]);
  }
  const scale = stackPoints.map(([time, value]) => {
    const total = models.reduce((sum, entry) => sum + shareAt(entry.list, time), 0);
    return total > 0 ? value / total : 1;
  });
  let below = stackPoints.map(() => 0);
  const stacks = models.map((entry) => {
    const top = stackPoints.map(([time], index) => below[index] + shareAt(entry.list, time) * scale[index]);
    const { area } = meterPaths(stackPoints, x, y, top, below);
    below = top;
    return { ...entry, area };
  });
  const stacked = stacks.some((entry) => entry.area);
  // The legend names the models only; the forecast, pace and unmeasured
  // strokes read for themselves on the plot (user: 범례에서 예상 · 적정 속도
  // · 측정 못 한 구간은 빼고).
  const legend: LegendItem[] = stacked
    ? stacks.map((entry) => ({ key: `series:${entry.key}`, label: entry.label, series: entry.ink }))
    : [];
  const axis = axisTicks(from, to);
  const axisFormat = new Intl.DateTimeFormat(
    uiFormatLocale(),
    axis.unit === 'month' && new Date(from).getFullYear() !== new Date(to).getFullYear()
      ? { year: 'numeric', month: 'short' }
      : AXIS_FORMATS[axis.unit]
  );
  const ticks = axis.times.filter((time) => {
    const share = x(time) / WIDTH;
    const clearOfNow = nowX === null || Math.abs(share - nowX / WIDTH) >= AXIS_NOW_GAP;
    return share >= AXIS_EDGE && share <= 1 - AXIS_EDGE && clearOfNow;
  });
  const clockRange = (start: number, end: number) =>
    new Intl.DateTimeFormat(uiFormatLocale(), { hour: '2-digit', minute: '2-digit' }).formatRange(
      new Date(start),
      new Date(end)
    );
  const slotTitle = (slot: Row) =>
    trendPeriodLabel({
      fromMs: statsNumber(slot.fromMs),
      toMs: statsNumber(slot.toMs),
      startDay: '',
      endDay: '',
      label: '',
    });
  const rate = statsNumber(forecast.ratePerHour);
  const slotModels = rows(active?.models).filter((row) => statsNumber(row.consumed) > 0 || statsNumber(row.tokens) > 0);
  const slotOutside = statsNumber(active?.outside);
  // Chart space with no slot to read ends a hover card; a pinned one stays.
  const idle = {
    onMouseEnter: () => {
      if (!detail.popover.pinned) detail.popover.setOpen(false);
    },
  };
  return (
    <section
      className="stats-trend quota-trend"
      data-usage-provider={provider}
      data-stacked={stacked ? 'true' : undefined}
    >
      <header>
        {/* The chart names itself; the heading stays for assistive technology. */}
        <h4 className="sr-only">{t('Trend')}</h4>
        {windowView && rate > 0 && <span>{t('Rate {{rate}} per hour', { rate: quotaPercent(rate) })}</span>}
      </header>
      {loading ? (
        <div className="quota-chart-skeleton usage-skeleton" aria-hidden="true" />
      ) : (
        <div className="quota-chart" {...detail.hostProps}>
          <div className="quota-chart-plot">
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id={areaFill} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" className="quota-chart-area-top" />
                  <stop offset="1" className="quota-chart-area-bottom" />
                </linearGradient>
                {/* Each model layer fades down to the baseline in its own ink,
                so the stack reads as one soft area split by hue rather than
                a solid slab (user: 깔끔하게 좀 만들어 줘, 되게 지저분하고). */}
                {stacks.map((entry, index) => (
                  <linearGradient
                    key={entry.key}
                    id={`${areaFill}-${index}`}
                    data-series={entry.ink}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0" className="quota-chart-stack-top" />
                    <stop offset="1" className="quota-chart-stack-bottom" />
                  </linearGradient>
                ))}
              </defs>
              {nowX !== null && (
                <rect
                  className="quota-chart-ahead"
                  x={coordinate(nowX)}
                  y="0"
                  width={coordinate(WIDTH - nowX)}
                  height={HEIGHT}
                />
              )}
              {[25, 50, 75].map((value) => (
                <line
                  key={value}
                  className="quota-chart-grid"
                  x1="0"
                  x2={WIDTH}
                  y1={coordinate(y(value))}
                  y2={coordinate(y(value))}
                />
              ))}
              <line className="quota-chart-limit" x1="0" x2={WIDTH} y1={coordinate(y(100))} y2={coordinate(y(100))} />
              {pacePath && <path className="quota-chart-pace" d={pacePath} />}
              {!stacked && paths.area && (
                <path className="quota-chart-area" d={paths.area} style={{ fill: `url(#${areaFill})` }} />
              )}
              {stacks.map(
                (entry, index) =>
                  entry.area && (
                    <path
                      key={entry.key}
                      className="quota-chart-stack"
                      data-series={entry.ink}
                      d={entry.area}
                      style={{ fill: `url(#${areaFill}-${index})` }}
                    />
                  )
              )}
              {paths.unmeasured && <path className="quota-chart-unmeasured" d={paths.unmeasured} />}
              {paths.measured && <path className="quota-chart-line" d={paths.measured} />}
              {forecastPath && <path className="quota-chart-forecast" d={forecastPath} />}
              {nowX !== null && (
                <line className="quota-chart-now" x1={coordinate(nowX)} x2={coordinate(nowX)} y1="0" y2={HEIGHT} />
              )}
              {marker && (
                <line
                  className="quota-chart-dot"
                  x1={coordinate(x(marker.time))}
                  x2={coordinate(x(marker.time))}
                  y1={coordinate(y(100))}
                  y2={coordinate(y(100))}
                />
              )}
            </svg>
            {[0, 50, 100].map((value) => (
              <span key={value} className="quota-chart-y" style={{ top: `${y(value)}%` }}>
                {`${value}%`}
              </span>
            ))}
            {marker && (
              <span className="quota-chart-marker" style={{ left: left(marker.time), top: `${y(100)}%` }}>
                {marker.label}
              </span>
            )}
            {peaks.length <= PEAK_LABEL_LIMIT &&
              peaks.map((row) => (
                <span
                  key={String(row.key)}
                  className="quota-chart-peak"
                  style={{ left: left(statsNumber(row.peakAt)), top: `${y(statsNumber(row.peak))}%` }}
                >
                  {quotaPercent(row.peak)}
                </span>
              ))}
            <div className="quota-chart-slots">
              {slots.map((slot) => {
                const key = String(slot.fromMs);
                const fromMs = statsNumber(slot.fromMs);
                const toMs = statsNumber(slot.toMs);
                const flexBasis = `${((toMs - fromMs) / span) * 100}%`;
                // A slot yet to start has nothing to read.
                if (slot.future === true) {
                  return (
                    <span key={key} className="quota-chart-slot" style={{ flexBasis }} aria-hidden="true" {...idle} />
                  );
                }
                // The slot running now keeps its whole span; what has passed of
                // it is shaded apart from what is still ahead.
                const elapsed = now < toMs ? `${((now - fromMs) / (toMs - fromMs)) * 100}%` : undefined;
                const open = detail.popover.open && detail.activeKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className="quota-chart-slot"
                    style={{ flexBasis, '--quota-slot-elapsed': elapsed } as CSSProperties}
                    aria-label={`${slotTitle(slot)} · ${quotaPercent(slot.endPct)}`}
                    aria-expanded={open}
                    aria-controls={open ? detail.detailId : undefined}
                    {...detail.interaction(key)}
                  />
                );
              })}
            </div>
          </div>
          {detail.popover.open && active && (
            <TrendDetailCard detail={detail} title={slotTitle(active)}>
              {activeRunning && (
                <ul className="quota-slot-split">
                  <li>
                    <span>{`${t('Used')} · ${clockRange(statsNumber(active.fromMs), now)}`}</span>
                    <b>{activeUsed}</b>
                  </li>
                  {activeForecast !== null && (
                    <li>
                      <span>{`${t('Forecast')} · ${clockRange(now, activeEnd)}`}</span>
                      <b>{`${quotaPercent(active.endPct)} → ${quotaPercent(activeForecast)}`}</b>
                    </li>
                  )}
                  {runsOutAt > now && runsOutAt <= activeEnd && (
                    <li>
                      <span>{runsOutLabel}</span>
                    </li>
                  )}
                </ul>
              )}
              <dl className="stats-trend-detail-totals">
                {!activeRunning && (
                  <div>
                    <dt>{t('Used')}</dt>
                    <dd>{activeUsed}</dd>
                  </div>
                )}
                <div>
                  <dt>{t('Tokens')}</dt>
                  <dd>{statsTokens(active.tokens)}</dd>
                </div>
                <div>
                  <dt>{t('List-price value')}</dt>
                  <dd title={`${quotaValueBreakdown(active)}\n${quotaValueCaution()}`}>{quotaValue(active)}</dd>
                </div>
              </dl>
              {(slotModels.length > 0 || slotOutside > 0) && (
                <ul aria-label={t('Model')}>
                  {slotModels.map((row) => (
                    <li key={String(row.model)}>
                      <span>
                        <i data-series={seriesInk(String(row.model || ''))} aria-hidden="true" />
                        {modelDisplayName(String(row.model || ''), provider)}
                      </span>
                      <b>{`+${quotaPercent(row.consumed)}`}</b>
                    </li>
                  ))}
                  {slotOutside > 0 && (
                    <li>
                      <span>
                        <i data-series="outside" aria-hidden="true" />
                        {t('Outside Mixdog')}
                      </span>
                      <b>{`+${quotaPercent(slotOutside)}`}</b>
                    </li>
                  )}
                </ul>
              )}
            </TrendDetailCard>
          )}
        </div>
      )}
      {!loading && (
        <div className="quota-chart-axis" aria-hidden="true">
          {ticks.map((time) => (
            <span key={time} style={{ left: left(time) }}>
              {axisFormat.format(new Date(time))}
            </span>
          ))}
          {nowX !== null && (
            <span className="quota-chart-axis-now" style={{ left: left(now) }}>
              {t('Now')}
            </span>
          )}
        </div>
      )}
      {legend.length > 0 && (
        <ul className="stats-trend-legend quota-legend">
          {legend.map((item) => (
            <li key={item.key}>
              <i data-series={item.series} aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
