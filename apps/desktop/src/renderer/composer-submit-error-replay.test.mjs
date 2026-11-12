// Replay of native/core/fixtures/composer-submit-error-cases (record-composer-submit-error-cases.mjs, Node b6f10295a): the refusal of a
// send to a switched-off room member as the composer shows it (IPC and relay), and the relay frames a phone receives for it, on the
// product's own modules, compared whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composerErrorScenarios } from '../../../../benchmarks/rust-core/recorders/lib/composer-error-scenarios.mjs';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { executeRemoteFrame } from '../main/remote-methods';
import { codedErrorParams, ipcErrorEnvelope, ipcErrorFromEnvelope } from '../shared/coded-error';
import { roomMemberSwitchedOffError } from '../shared/room-error-codes';
import { SUPPORTED_UI_LANGUAGES } from '../shared/ui-language';
import { composerSubmitErrorText } from './composer-submit-error';
import i18n from './i18n';

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/composer-submit-error-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = composerErrorScenarios({
  i18n,
  composerSubmitErrorText,
  codedErrorParams,
  ipcErrorEnvelope,
  ipcErrorFromEnvelope,
  roomMemberSwitchedOffError,
  executeRemoteFrame,
  SUPPORTED_UI_LANGUAGES,
  readLocale: (value) => JSON.parse(readFileSync(new URL(`./locales/${value}.json`, import.meta.url), 'utf8')),
});

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
