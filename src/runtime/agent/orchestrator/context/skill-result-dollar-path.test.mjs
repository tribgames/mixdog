import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSkillResultEnvelope } from './skill-catalog.mjs';

test('a skill directory with $ patterns is substituted into the body verbatim', () => {
  const skillDir = "C:\\skills\\$&\\a$$b$'c$`d$1";
  const out = buildSkillResultEnvelope('demo', `run \${MIXDOG_SKILL_DIR}/x.mjs now`, skillDir);
  assert.ok(out.includes("run C:/skills/$&/a$$b$'c$`d$1/x.mjs now"), out);
});
