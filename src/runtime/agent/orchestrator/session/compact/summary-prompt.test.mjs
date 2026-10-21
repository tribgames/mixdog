import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCompleteCompactionPrompt } from './summary.mjs';

test('summarizer prompt separates announced intent from tool-evidenced work and keeps decision sources', () => {
  const prompt = fitCompleteCompactionPrompt(
    {
      head: [{ role: 'assistant', content: 'I will hand this to an agent.' }],
      previousSummary: '',
      preservedFacts: '',
    },
    1_000_000
  );
  assert.match(prompt, /Done or In Progress only when a tool call and its result/);
  assert.match(prompt, /"announced, not started"/);
  assert.match(
    prompt,
    /Attribute every decision[^\n]*ask_user answer[^\n]*Never credit an agent or the assistant with a user's answer/
  );
});
