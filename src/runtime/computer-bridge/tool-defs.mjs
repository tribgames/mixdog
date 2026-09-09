import {
  COMPUTER_INPUT_SCHEMA,
  COMPUTER_OBSERVATION_ACTIONS,
} from './action-schema.mjs';

// Contract only: what the host enforces (call cadence, exact targets, ref
// expiry, which actions are observation-only). Policy, mode selection,
// recovery, and flows live in the built-in `computer-use` skill; the schema
// below owns every field.
const COMPUTER_TOOL_DESCRIPTION = [
  'Operate the local Windows desktop through Mixdog (Windows only). Last resort after an MCP tool, shell/CLI, and Browser Use (browser): only native apps and GUI-only tools; never a stand-in for a page action browser refused.',
  'Load the computer-use skill before first use.',
  'At most one computer call per model turn; chain same-window steps inside one act.',
  'Every window action names one exact target (window_id, or app resolving to one window); input requires a fresh observation from capture or the previous result.',
  'Refs, marks, and frames come only from the latest unexpired observation of the same window (60 seconds, invalidated by UI mutation); an automatic post-action observation replaces the old state. Never guess ids.',
  `Observation-only actions, safe to repeat: ${COMPUTER_OBSERVATION_ACTIONS.join(', ')}. Every other action can move the desktop.`,
].join(' ');

/**
 * `computer` drives the local Windows desktop through the Mixdog app's
 * loopback bridge. It stays deferred and appears only while Computer Use is
 * enabled. `act` owns the compact input batch and automatic fresh observation;
 * the remaining high-level operations own observation and advanced capability.
 */
export const TOOL_DEFS = [
  {
    name: 'computer',
    title: 'Mixdog Computer Use',
    description: COMPUTER_TOOL_DESCRIPTION,
    inputSchema: COMPUTER_INPUT_SCHEMA,
  },
];
