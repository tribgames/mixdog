import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCompleteCompactionPrompt } from './summary.mjs';

const promptFor = () =>
  fitCompleteCompactionPrompt(
    {
      head: [{ role: 'assistant', content: 'I will hand this to an agent.' }],
      previousSummary: '',
      preservedFacts: '',
    },
    1_000_000
  );

test('summarizer prompt only records tool-evidenced work as progress', () => {
  const prompt = promptFor();
  assert.match(prompt, /only when a tool call and its result/);
  assert.match(prompt, /announced, not started/);
});

test('summarizer prompt attributes user decisions to the user, not to agents', () => {
  const prompt = promptFor();
  assert.match(prompt, /Attribute every decision/);
  assert.match(prompt, /ask_user answer/);
  assert.match(prompt, /Never credit an agent or the assistant with a user's answer/);
});

test('summarizer prompt keeps the user requests and pending work sections', () => {
  const prompt = promptFor();
  assert.match(prompt, /## Goal/);
  assert.match(prompt, /## Constraints & Preferences/);
  assert.match(prompt, /## Next Steps/);
  assert.match(prompt, /Keep every section/);
});
