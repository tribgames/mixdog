import { mkdirSync, appendFileSync, appendFile as _appendFileAsync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.mjs';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../../shared/runtime-root.mjs';
const NOPLUGIN_DIR = join(resolveRuntimeRoot(), 'noplugin');
const EVENT_LOG = join(DATA_DIR, 'event.log');
// Buffered async logger — coalesces per-line appends into batched writes.
let _eventLogBuf = [];
let _eventLogTimer = null;
function _drainEventLog() {
  if (_eventLogBuf.length === 0) return '';
  const lines = _eventLogBuf.join('');
  _eventLogBuf = [];
  return lines;
}
function _flushEventLog() {
  _eventLogTimer = null;
  const lines = _drainEventLog();
  if (lines) _appendFileAsync(EVENT_LOG, lines, () => {});
}
function _flushEventLogSync() {
  const lines = _drainEventLog();
  if (!lines) return;
  try {
    appendFileSync(EVENT_LOG, lines);
  } catch {}
}
process.on('exit', _flushEventLogSync);
function logEvent(msg) {
  try {
    process.stderr.write(`mixdog event: ${msg}\n`);
  } catch {}
  _eventLogBuf.push(`[${new Date().toISOString()}] ${msg}\n`);
  if (!_eventLogTimer) _eventLogTimer = setTimeout(_flushEventLog, 2000);
}
function parseGithub(body, headers) {
  const event = headers['x-github-event'] || '';
  const action = body.action || '';
  const pr = body.pull_request || body.issue || {};
  return {
    event,
    action,
    title: pr.title || body.head_commit?.message || '',
    author: pr.user?.login || body.sender?.login || '',
    repo: body.repository?.full_name || '',
    url: pr.html_url || body.compare || '',
    branch: body.ref || pr.head?.ref || '',
    message: body.head_commit?.message || '',
  };
}
function parseSentry(body) {
  const data = body.data || {};
  const evt = data.event || data.issue || {};
  return {
    title: evt.title || body.message || '',
    level: evt.level || body.level || '',
    project: body.project_name || body.project || '',
    url: evt.web_url || body.url || '',
  };
}
function parseGeneric(body) {
  const result = {};
  const keys = Object.keys(body).slice(0, 5);
  for (const k of keys) {
    result[k] = typeof body[k] === 'string' ? body[k] : JSON.stringify(body[k]);
  }
  return result;
}
function applyParser(parser, body, headers) {
  switch (parser) {
    case 'github':
      return parseGithub(body, headers);
    case 'sentry':
      return parseSentry(body);
    case 'generic':
      return parseGeneric(body);
    default:
      return { raw: JSON.stringify(body) };
  }
}
/** One `field == "value"` / `field != "value"` condition; anything else is false. */
function conditionHolds(condition, data) {
  const eq = condition.match(/^(\w+)\s*==\s*['"](.*)['"]$/);
  if (eq) return (data[eq[1]] ?? '') === eq[2];
  const neq = condition.match(/^(\w+)\s*!=\s*['"](.*)['"]$/);
  if (neq) return (data[neq[1]] ?? '') !== neq[2];
  return false;
}
function evaluateFilter(expr, data) {
  return expr
    .split('||')
    .some((orPart) => orPart.split('&&').every((condition) => conditionHolds(condition.trim(), data)));
}
function applyTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? '');
}
function ensureNopluginDir() {
  ensurePrivateRuntimeRoot();
  mkdirSync(NOPLUGIN_DIR, { recursive: true });
}
export { applyParser, applyTemplate, ensureNopluginDir, evaluateFilter, logEvent };
