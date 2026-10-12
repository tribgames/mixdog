import assert from 'node:assert/strict';
import test from 'node:test';
import { formatElapsed } from './text-format.ts';
import { uiTimeUnit } from './ui-format.ts';

test('elapsed time preserves sub-hour output and switches to hours at 60 minutes', () => {
  const cases = [
    [0, []],
    [999, []],
    [1_000, [[1, 'second']]],
    [60_000, [[1, 'minute']]],
    [
      3_599_999,
      [
        [59, 'minute'],
        [59, 'second'],
      ],
    ],
    [3_600_000, [[1, 'hour']]],
    [
      3_601_000,
      [
        [1, 'hour'],
        [0, 'minute', true],
        [1, 'second', true],
      ],
    ],
    [
      3_660_000,
      [
        [1, 'hour'],
        [1, 'minute', true],
      ],
    ],
    [
      8_785_000,
      [
        [2, 'hour'],
        [26, 'minute', true],
        [25, 'second', true],
      ],
    ],
    [90_000_000, [[25, 'hour']]],
  ];
  for (const [elapsedMs, units] of cases) {
    assert.equal(
      formatElapsed(elapsedMs),
      units.map(([value, unit, pad]) => uiTimeUnit(value, unit, pad)).join(' '),
      `elapsedMs=${elapsedMs}`
    );
  }
});

test('running timers are compact and zero-pad every unit after the first', () => {
  assert.equal(formatElapsed(59_000), '59s');
  assert.equal(formatElapsed(65_000), '1m 05s');
  assert.equal(formatElapsed(125_000), '2m 05s');
  assert.equal(formatElapsed(7_389_000), '2h 03m 09s');
  assert.equal(formatElapsed(3_605_000), '1h 00m 05s');
});

test('zero padding follows the active locale unit style', async () => {
  const { default: i18next } = await import('./i18n.ts');
  const expected = {
    ko: '2시간 03분 09초',
    'zh-CN': '2小时 03分钟 09秒',
    de: '2 Std. 03 Min. 09 Sek.',
    fr: '2h 03min 09s',
    ru: '2 ч 03 мин 09 с',
  };
  const previous = i18next.language;
  try {
    for (const [language, text] of Object.entries(expected)) {
      await i18next.changeLanguage(language);
      assert.equal(formatElapsed(7_389_000), text, language);
    }
  } finally {
    await i18next.changeLanguage(previous);
  }
});
