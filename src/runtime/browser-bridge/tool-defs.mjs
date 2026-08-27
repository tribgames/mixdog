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
    title: 'Mixdog Browser Use',
    description: 'Drive a browser tab in the Mixdog desktop app — real Chromium sharing the user\'s login sessions. snapshot lists interactive elements with refs (e.g. e12) that click/fill target; refs reset on every navigation, so re-snapshot after the page changes. navigate/click/press return a fresh snapshot; screenshot returns the rendered viewport image; read returns the page text. Set background:true to work in a hidden offscreen page (same logins, nothing shown to the user) instead of the visible tab; name background pages with tab to run several in parallel, and enumerate everything with list_tabs. '
      + TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'snapshot', 'click', 'fill', 'press', 'scroll', 'back', 'forward', 'screenshot', 'read', 'wait', 'list_tabs', 'close_tab', 'downloads', 'open'],
          description: 'navigate opens url; snapshot maps the page; click/fill act on a ref; press sends a key; scroll moves the viewport; back/forward walk history; screenshot captures the viewport; read extracts page text; wait polls until text/url appears; list_tabs lists visible and background tabs; close_tab closes a named background tab; downloads lists files saved this session; open just presents the pane.',
        },
        url: { type: 'string', description: 'navigate target; http(s) only, scheme optional. For wait: a URL substring to wait for.' },
        ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e12); required by click and fill.' },
        text: { type: 'string', description: 'fill: replacement value for the element. wait: a page-text substring to wait for.' },
        submit: { type: 'boolean', description: 'fill only: press Enter after filling.' },
        key: {
          type: 'string',
          description: 'press target: enter, tab, escape, backspace, delete, arrowup, arrowdown, arrowleft, arrowright, pageup, pagedown, home, end.',
        },
        dy: { type: 'integer', description: 'scroll distance in px (negative scrolls up); omit for one viewport down.' },
        maxChars: { type: 'integer', minimum: 1, description: 'read cap; default 8000, max 30000.' },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 30000, description: 'wait ceiling in ms; default 10000.' },
        tab: { type: 'string', description: 'Target tab: "v1"/"v2"… selects a visible tab (list_tabs order); any other name is a named background page — pass background:true to create it on first use. Omit for the active visible tab (or the default "bg" background page).' },
        background: { type: 'boolean', description: 'Act on a hidden offscreen page (same logins, invisible to the user) instead of the visible tab. Keep it consistent across a task\'s steps so the page persists.' },
      },
      required: ['action'],
    },
  },
];