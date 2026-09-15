import assert from 'node:assert/strict';
import test from 'node:test';
import { usagePinEntries } from './SidebarUsage.tsx';

const dashboard = (windows) => ({ rows: [
  { id: 'antigravity-oauth', group: 'oauth', authenticated: true, windows },
] });

test('Antigravity uses the higher Flash/Pro usage, independent of window order and other models', () => {
  const windows = [
    { label: 'FLSH', usedPct: 12 }, { label: 'CLD', usedPct: 98 },
    { label: 'PRO', usedPct: 24 }, { label: 'GPT', usedPct: 0 },
  ];
  assert.equal(usagePinEntries(dashboard(windows))[0].percent, 24);
  assert.equal(usagePinEntries(dashboard([...windows].reverse()))[0].percent, 24);
  assert.equal(usagePinEntries(dashboard([
    { label: 'FLASH', usedPct: 36 }, { label: 'PRO', usedPct: 1 },
  ]))[0].percent, 36);
});

test('missing Flash/Pro data never falls back to Claude or GPT and known zero stays visible', () => {
  assert.deepEqual(usagePinEntries(dashboard([{ label: 'GPT', usedPct: 75 }])), []);
  assert.equal(usagePinEntries(dashboard([
    { label: 'FLSH', usedPct: 0 }, { label: 'PRO', usedPct: null }, { label: 'GPT', usedPct: 75 },
  ]))[0].percent, 0);
});

test('other providers retain their existing quota-window selection', () => {
  const entries = usagePinEntries({ rows: [
    { id: 'openai-oauth', group: 'oauth', windows: [{ label: '5H', usedPct: 90 }, { label: '7D', usedPct: 20 }] },
    { id: 'cursor-oauth', group: 'oauth', windows: [{ label: 'Basic', usedPct: 10 }, { label: 'API', usedPct: 50 }] },
  ] });
  assert.deepEqual(entries.map(({ key, percent }) => [key, percent]), [['codex', 20], ['cursor', 10]]);
});
