// Behavior contract for the conservative token estimator.
//
// Exactness is NOT the contract. Context pressure anchors on the provider
// usage baseline and only the delta since it is estimated locally, so what
// matters is DIRECTION: the estimate may never read below a real o200k encode,
// because undercounting overflows the context window (a failed turn) while
// overcounting merely compacts a little early. The upper band keeps that
// safety margin from turning into wasted context.
//
// Every o200k figure below is a real encode of that exact string, measured
// once and pinned here so the guarantee stays checkable without shipping a
// tokenizer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateTokens, UNCALIBRATED_ESTIMATE_MARGIN } from './token-estimate.mjs';

const UPPER_BAND = 2.5;
const KOREAN = '재영님, 토큰 추정기는 서버 usage 기준선 위에서 델타만 계산합니다. '.repeat(40);

const PROBES = [
    ['korean prose', KOREAN, 881],
    ['english prose', 'The estimator only prices the delta appended since the provider usage baseline. '.repeat(40), 521],
    ['base64 payload', 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGJhc2U2NCBibG9iIHBheWxvYWQ='.repeat(60), 2101],
    ['hex payload', 'deadbeefcafebabe0123456789abcdef'.repeat(80), 880],
    ['jsonl log', '{"level":"info","msg":"tool finished","ms":12,"ok":true}\n'.repeat(80), 1440],
];

test('an estimate never reads below a real o200k encode', () => {
    for (const [label, text, o200k] of PROBES) {
        const est = estimateTokens(text);
        assert.ok(est >= o200k, `${label}: est=${est} must not read below o200k=${o200k}`);
    }
});

test('an estimate stays inside the conservative band', () => {
    for (const [label, text, o200k] of PROBES) {
        const est = estimateTokens(text);
        assert.ok(est <= o200k * UPPER_BAND, `${label}: est=${est} exceeds the band (o200k=${o200k})`);
    }
});

test('Korean prices far above the chars/4 rule that reads low for it', () => {
    const chars4 = Math.ceil(KOREAN.length / 4);
    assert.ok(chars4 < 881, 'the chars/4 rule must be the one reading low on this probe');
    assert.ok(
        estimateTokens(KOREAN) > chars4 * 2,
        'Korean must price well above chars/4, which undercounts it ~2.15x',
    );
});

test('a long unmerged run costs more per character than spaced prose', () => {
    const run = 'a1b2c3d4'.repeat(40);
    const prose = 'word '.repeat(64);
    assert.equal(run.length, prose.length);
    assert.ok(
        estimateTokens(run) > estimateTokens(prose),
        'base64/hex-shaped runs receive almost no BPE merges and must cost more',
    );
});

test('empty and absent input costs nothing', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
});

test('the unanchored margin can only widen an estimate', () => {
    assert.ok(UNCALIBRATED_ESTIMATE_MARGIN > 1, 'the margin must add headroom, never remove it');
});
