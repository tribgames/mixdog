import { TOOL_SYNC_EXECUTION_CONTRACT } from '../shared/tool-execution-contract.mjs';

/**
 * `visualize` shows produced artifacts in the Mixdog desktop app's side panel
 * over a loopback bridge. Deferred, and present only while the desktop
 * Visualize bridge is up and the feature is on.
 */
export const TOOL_DEFS = [
  {
    name: 'visualize',
    title: 'Mixdog Visualize',
    description:
      'Show the user any artifact you produced or changed (mockups, docs, decks, sheets, PDFs, images, video, local dev pages) in the desktop side panel beside the chat. Panel tabs auto-reload when a file changes, so re-opening after edits is unnecessary. ' +
      'open: input.targets (1-3 file paths, relative to the working directory or absolute anywhere on this machine; 2-3 = side-by-side comparison; or a single http(s) URL alone, never mixed with files or other URLs), optional label, optional version (show that kept version of a file tab read-only; each open/reload that changes the files keeps a version). close: optional tab (omit = all). ' +
      'annotate: tab + add [{selector,label?}] | remove [selector] | clear; HTML pages only, never edits the file. capture: tab + output (.png path). ' +
      'export: tab + format (png|pdf) + output (project-relative path ending .png/.pdf) + optional version (a kept version of the tab) + optional overwrite (true replaces an existing file, only under design/; otherwise an existing file is refused). Writes a record of the approved page inside the project and returns its project-relative path, size/dimensions and the page problems seen while rendering. A single HTML page (file, or inline html/chart) is rendered whole in a hidden window, so the tab need not be on screen (PDF: HTML pages only; PNG has a pixel cap, over it export pdf or shorten the page); any other tab exports as capture does (the displayed tab, PNG only). Same project containment as capture: links and paths outside the working directory are refused. ' +
      'check: tab; HTML pages only; waits briefly for the page to settle and returns only its runtime problems (uncaught errors, unhandled rejections, CSP violations, console errors/warnings, missing local assets). ' +
      'inspect: tab + optional viewport {width,height} (e.g. 375x812 to look at a mobile layout) + optional selector (scope); HTML pages with scripts/styles only (not static mermaid/svg/markdown). Returns a compact text read-out of the rendered page without a screenshot: viewport, landmarks and headings, interactive elements (role, accessible name, selector, x/y/w/h), and layout findings (horizontal overflow, clipped text, overlapping or tiny tap targets, low text contrast, images without alt, unlabeled inputs). Run it (desktop width and, for responsive designs, a mobile width) and fix the findings before reporting; `check` also says when findings exist. Secret field values are never included. ' +
      'Any result about a tab ends with a "Page problems" section when the page has problems: fix them in the file and re-check before reporting; never report a page with unresolved problems as done. ' +
      'HTML pages run their scripts, but outside network (CDNs, web fonts, APIs, any other http(s)/ws address) is blocked unless the user allows it for the tab, so mockups must be self-contained; a blocked request appears as a "blocked-network" page problem on open/check. ' +
      'Direct renderers: instead of targets, open takes input.content {kind: mermaid|svg|chart|html|markdown, source, title?} (max 512 KiB; chart = an ECharts option as JSON) and shows it with no file written. ' +
      'Prefer inline content for diagrams, charts and quick sketches; write a file for real mockups that need iteration, scripts or versioning on disk. ' +
      'mermaid, svg and markdown render as static, sanitized output (no scripts, no network). chart (ECharts option JSON, interactive: tooltips, zoom) and html (scripts run) open as in-memory pages with the same protections as HTML file pages (outside network blocked, page problems captured); html content must be self-contained. Re-open with the same title to add a version. A render error (Mermaid parse error, bad chart JSON) is returned as a page problem: fix the source and open again. ' +
      'Tweaks: an HTML page (file or inline html/chart) can declare adjustable parameters in <script type="application/json" id="mx-tweaks">[{id,label,type:color|range|select|toggle,var:"--name" or attr:"data-name",min,max,step,unit,options:[{value,label}],default}] (max 16, keep it to a few meaningful ones). The panel shows a Tweaks drawer and applies changes live to the page root (CSS variables / data attributes your CSS and script read); the chosen values come back with their next message under tweaks: to bake into the file. A malformed block is a "tweaks: <reason>" page problem. ' +
      'Does not replace browser for clicking/typing. ' +
      TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'close', 'annotate', 'capture', 'export', 'check', 'inspect'] },
        input: {
          type: 'object',
          properties: {
            targets: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 3,
              description:
                'open: 1-3 file paths (side by side), relative to the working directory or absolute in any folder, or exactly one http(s) URL as the only target.',
            },
            content: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['mermaid', 'svg', 'chart', 'html', 'markdown'] },
                source: {
                  type: 'string',
                  maxLength: 524288,
                  description: 'Diagram text, SVG/HTML/Markdown source, or an ECharts option as JSON (chart).',
                },
                title: { type: 'string', description: 'Tab title; re-opening the same title adds a version.' },
              },
              required: ['kind', 'source'],
              additionalProperties: false,
              description: 'open: render this directly instead of files. Exclusive with targets.',
            },
            label: { type: 'string', description: 'open: tab label.' },
            version: {
              type: 'integer',
              minimum: 1,
              description:
                'open (file tabs): kept version number to show read-only instead of the live files. export: kept version number to render instead of the live page.',
            },
            tab: { type: 'string', description: 'Tab id from open (close: omit for all).' },
            add: {
              type: 'array',
              items: {
                type: 'object',
                properties: { selector: { type: 'string' }, label: { type: 'string' } },
                required: ['selector'],
                additionalProperties: false,
              },
              description: 'annotate: CSS selectors to outline.',
            },
            remove: { type: 'array', items: { type: 'string' }, description: 'annotate: selectors to un-outline.' },
            clear: { type: 'boolean', description: 'annotate: remove all outlines.' },
            output: {
              type: 'string',
              description:
                'capture: project path ending .png. export: project path ending .png or .pdf (matching format).',
            },
            format: { type: 'string', enum: ['png', 'pdf'], description: 'export: file format.' },
            overwrite: {
              type: 'boolean',
              description: 'export: replace an existing output file; honored only for paths under design/.',
            },
            viewport: {
              type: 'object',
              properties: {
                width: { type: 'integer', minimum: 200, maximum: 3000 },
                height: { type: 'integer', minimum: 200, maximum: 4000 },
              },
              required: ['width'],
              additionalProperties: false,
              description:
                "inspect: size to lay the page out at (height defaults to 800); omit for the panel's current size.",
            },
            selector: {
              type: 'string',
              maxLength: 500,
              description: 'inspect: CSS selector scoping the read-out to one subtree.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];
