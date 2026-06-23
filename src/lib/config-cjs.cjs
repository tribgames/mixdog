'use strict';
/**
 * CJS shim for shared config reading in hooks.
 *
 * Read-only mirror of src/shared/config.mjs's section accessor. Hook
 * processes only read mixdog-config.json — never write, never rename.
 */

const fs = require('fs');
const path = require('path');
const { resolvePluginData } = require('./plugin-paths.cjs');
const { getSecret: _getSecret } = require('./keychain-cjs.cjs');

const DATA_DIR = resolvePluginData();

const GENERATED_KEY = '_generated';

function stripGeneratedMarker(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (!Object.prototype.hasOwnProperty.call(data, GENERATED_KEY)) return data;
  const { [GENERATED_KEY]: _unused, ...rest } = data;
  return rest;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readSection(section) {
  const unified = readJsonFile(path.join(DATA_DIR, 'mixdog-config.json'));
  if (!unified || typeof unified !== 'object') return {};
  const raw = unified[section];
  if (raw == null) return {};
  return stripGeneratedMarker(raw) || {};
}

// ── Secret-aware getters (CJS, for hooks) ────────────────────────────────────
// Read order: ENV MIXDOG_<UPPER_SNAKE> → OS keychain → null.

function _envKey(account) {
  return 'MIXDOG_' + account.replace(/[.\s]+/g, '_').toUpperCase();
}

function _readSecret(account) {
  const envVal = process.env[_envKey(account)];
  if (envVal) return envVal;
  try { return _getSecret(account); } catch { return null; }
}

function getDiscordToken() {
  return _readSecret('discord.token');
}

module.exports = {
  readSection,
  getDiscordToken,
};
