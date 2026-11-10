import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMcpServerInput, parseSkillInput } from './input-parsers.mjs';

test('MCP command fields trim boundaries, preserve positions and retain missing-field defaults', () => {
  assert.deepEqual(parseMcpServerInput(' graph | node | --stdio   --safe | C:/project | ignored '), {
    server: { name: 'graph', command: 'node', args: ['--stdio', '--safe'], cwd: 'C:/project' },
  });
  assert.deepEqual(parseMcpServerInput('graph | node'), {
    server: { name: 'graph', command: 'node', args: [], cwd: '' },
  });
  assert.deepEqual(parseMcpServerInput('graph | node | | C:/project'), {
    server: { name: 'graph', command: 'node', args: [], cwd: 'C:/project' },
  });
  const missing = { error: 'usage: name | command-or-url | args(optional) | cwd(optional)' };
  assert.deepEqual(parseMcpServerInput(undefined), missing);
  assert.deepEqual(parseMcpServerInput(' | node'), missing);
  assert.deepEqual(parseMcpServerInput('graph | '), missing);
});

test('MCP network URLs retain their spelling and ignore command-only fields', () => {
  assert.deepEqual(parseMcpServerInput(' web | WSS://example.test/socket | ignored | ignored '), {
    server: { name: 'web', url: 'WSS://example.test/socket' },
  });
  assert.deepEqual(parseMcpServerInput('web | ftp://example.test'), {
    server: { name: 'web', command: 'ftp://example.test', args: [], cwd: '' },
  });
});

test('skill parsing distinguishes omitted descriptions from explicit blanks and preserves trigger text', () => {
  assert.deepEqual(parseSkillInput('pdf'), { skill: { name: 'pdf', description: 'Project skill.' } });
  assert.deepEqual(parseSkillInput('pdf | | '), { skill: { name: 'pdf', description: '' } });
  assert.deepEqual(parseSkillInput(' pdf | PDF documents | when   needed | ignored '), {
    skill: { name: 'pdf', description: 'PDF documents', whenToUse: 'when   needed' },
  });
  assert.deepEqual(parseSkillInput(' | description'), {
    error: 'usage: name | description(optional) | trigger(optional)',
  });
});
