'use strict';

/**
 * Canonical resolver for the Mixdog data dir.
 *
 * Resolution order:
 *   1. MIXDOG_DATA_DIR
 *   2. <MIXDOG_HOME|~/.mixdog>/data
 */

const path = require('path');
const os = require('os');

const DEFAULT_ROOT = path.join(__dirname, '..');

function mixdogHome() {
  return process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog');
}

function mixdogRoot() {
  return process.env.MIXDOG_ROOT || DEFAULT_ROOT;
}

function resolvePluginData() {
  return process.env.MIXDOG_DATA_DIR || path.join(mixdogHome(), 'data');
}

module.exports = { resolvePluginData, mixdogHome, mixdogRoot };
