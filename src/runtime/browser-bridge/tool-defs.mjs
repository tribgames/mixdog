import {
  TOOL_SYNC_EXECUTION_CONTRACT,
} from '../shared/tool-execution-contract.mjs';

/**
 * `browser` tool schema — drives the in-app browser pane of the Mixdog
 * desktop app over the loopback bridge (see browser-bridge/client.mjs).
 * The tool is only surfaced while a live bridge discovery file exists, so a
 * headless runtime never advertises it.
 */
export const TOOL_DEFS = [
  {
    name: 'browser',
    title: 'Mixdog Browser',
    description: 'Drive the visible browser tab in the Mixdog desktop app — real Chromium sharing the user\'s login sessions. snapshot lists interactive elements with refs (e.g. e12) that click/fill target; refs reset on every navigation, so re-snapshot after the page changes. navigate/click/press return a fresh snapshot; screenshot returns the rendered viewport image; read returns the page text. '
      + TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'snapshot', 'click', 'fill', 'press', 'scroll', 'back', 'forward', 'screenshot', 'read', 'open'],
          description: 'navigate opens url; snapshot maps the page; click/fill act on a ref; press sends a key; scroll moves the viewport; back/forward walk history; screenshot captures the viewport; read extracts page text; open just presents the pane.',
        },
        url: { type: 'string', description: 'navigate target; http(s) only, scheme optional.' },
        ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e12); required by click and fill.' },
        text: { type: 'string', description: 'fill value; replaces the element\'s current content.' },
        submit: { type: 'boolean', description: 'fill only: press Enter after filling.' },
        key: {
          type: 'string',
          description: 'press target: enter, tab, escape, backspace, delete, arrowup, arrowdown, arrowleft, arrowright, pageup, pagedown, home, end.',
        },
        dy: { type: 'integer', description: 'scroll distance in px (negative scrolls up); omit for one viewport down.' },
        maxChars: { type: 'integer', minimum: 1, description: 'read cap; default 8000, max 30000.' },
      },
      required: ['action'],
    },
  },
];