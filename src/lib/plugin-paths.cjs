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

function mixdogHome() {
  return process.env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog');
}

function resolvePluginData() {
  return process.env.MIXDOG_DATA_DIR || path.join(mixdogHome(), 'data');
}

module.exports = { resolvePluginData };
