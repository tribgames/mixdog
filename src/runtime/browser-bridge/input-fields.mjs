// The model schema and runtime value validator share these field definitions.
const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string', maxLength: 60 },
    name: { type: 'string', maxLength: 500 },
    selector: { type: 'string', maxLength: 4096 },
    exact: { type: 'boolean' },
    nth: { type: 'integer', minimum: 1, maximum: 500 },
  },
  additionalProperties: false,
  description:
    'Alternative to ref: role and/or name (substring; exact=verbatim) or a CSS selector; exactly one must match (nth picks).',
};
const NESTED_TARGET_SCHEMA = { type: 'object', description: 'As input.target.' };

export const BROWSER_INPUT_FIELDS = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'Action; pass only its fields in input.' },
    url: {
      type: 'string',
      maxLength: 8192,
      description:
        'navigate URL, or wait URL substring (reload: navigate reload:true). intercept add: wildcard like "*/api/*", else substring.',
    },
    ref: {
      type: 'string',
      maxLength: 128,
      description: 'Exact ref from the latest snapshot, e.g. p1-s3-e12; or use target.',
    },
    target: TARGET_SCHEMA,
    targetRef: { type: 'string', maxLength: 128, description: 'drag destination ref from the same snapshot.' },
    snapshotId: {
      type: 'string',
      maxLength: 128,
      description: 'Latest mode=both/locate snapshot ID for coordinate input.',
    },
    x: { type: 'number', minimum: 0, description: 'Target/source x in bound-image pixels.' },
    y: { type: 'number', minimum: 0, description: 'Target/source y in bound-image pixels.' },
    targetX: { type: 'number', minimum: 0, description: 'drag destination x in bound-image pixels.' },
    targetY: { type: 'number', minimum: 0, description: 'drag destination y in bound-image pixels.' },
    pointer: { type: 'string', enum: ['mouse', 'touch'], description: 'click/drag pointer; default mouse.' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click button (default left).' },
    modifiers: {
      type: 'array',
      items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
      uniqueItems: true,
      description: 'click modifiers.',
    },
    mode: {
      type: 'string',
      enum: ['semantic', 'visual', 'both'],
      description:
        'snapshot only: semantic refs (default), visual image, or both. Coordinates require both; fullPage requires visual. navigate uses includeScreenshot, not mode.',
    },
    fullPage: { type: 'boolean', description: 'Full-document screenshot; inspection-only.' },
    format: {
      type: 'string',
      enum: ['jpeg', 'png', 'pdf'],
      description: 'Image format; pdf prints a file via snapshot with mode=visual only.',
    },
    quality: { type: 'integer', minimum: 0, maximum: 100, description: 'Requires format=jpeg; default 75.' },
    image_output: {
      type: 'string',
      enum: ['inline', 'file'],
      description: 'inline (default) returns the image; file writes it and returns its path.',
    },
    script: {
      type: 'string',
      maxLength: 100000,
      description:
        'evaluate: JS expression/IIFE. With ref, element and this are that DOM element in its frame. Promises are awaited.',
    },
    requestId: {
      type: 'string',
      maxLength: 100,
      description: 'network: r1/r2 ID for headers, bodies, status, timing and failures; omit to list requests.',
    },
    frameLimit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'network WebSocket detail: newest frames to return; default 50.',
    },
    resourceTypes: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'document',
          'stylesheet',
          'image',
          'media',
          'font',
          'script',
          'texttrack',
          'xhr',
          'fetch',
          'prefetch',
          'eventsource',
          'websocket',
          'manifest',
          'signedexchange',
          'ping',
          'cspviolationreport',
          'preflight',
          'fedcm',
          'other',
        ],
      },
      maxItems: 20,
      description: 'network list, or intercept add: limit to these CDP resource types.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'locate/console/network/extract: maximum results, not maxChars.',
    },
    selector: {
      type: 'string',
      maxLength: 4096,
      description: 'extract only: CSS selector for the repeated rows, e.g. "li.product".',
    },
    attributes: {
      type: 'array',
      items: { type: 'string', maxLength: 60 },
      minItems: 1,
      maxItems: 12,
      description: 'extract only: attribute names per match; text and name always included.',
    },
    operation: {
      type: 'string',
      maxLength: 32,
      description:
        'cookies: list/set/delete/clear. storage: list/get/set/delete/clear. performance: metrics/start/stop. intercept and init_script: add/remove/list/clear, default list.',
    },
    storageType: {
      type: 'string',
      enum: ['local', 'session'],
      description: 'storage only: localStorage or sessionStorage; default local.',
    },
    name: { type: 'string', maxLength: 4096, description: 'cookies/storage item name or key.' },
    value: { type: 'string', maxLength: 100000, description: 'cookies/storage value for set.' },
    domain: { type: 'string', maxLength: 4096, description: 'cookies optional domain/filter.' },
    path: { type: 'string', maxLength: 4096, description: 'cookies optional path.' },
    secure: { type: 'boolean', description: 'cookies set: Secure attribute.' },
    httpOnly: { type: 'boolean', description: 'cookies set: HttpOnly attribute.' },
    sameSite: {
      type: 'string',
      enum: ['unspecified', 'no_restriction', 'lax', 'strict'],
      description: 'cookies set: SameSite attribute.',
    },
    expirationDate: { type: 'number', description: 'cookies set: expiry in Unix seconds; omit for a session cookie.' },
    width: { type: 'integer', minimum: 200, maximum: 3840, description: 'emulate viewport width; requires height.' },
    height: { type: 'integer', minimum: 200, maximum: 3840, description: 'emulate viewport height; requires width.' },
    deviceScaleFactor: {
      type: 'number',
      minimum: 0.5,
      maximum: 4,
      description: 'emulate device pixel ratio; default 1.',
    },
    mobile: { type: 'boolean', description: 'emulate mobile layout metrics.' },
    touch: {
      type: 'boolean',
      description: 'emulate touch support; click/drag with pointer=touch dispatch CDP touch events.',
    },
    userAgent: { type: 'string', maxLength: 2048, description: 'emulate user agent; empty string clears.' },
    locale: { type: 'string', maxLength: 100, description: 'emulate locale and Accept-Language, e.g. ko-KR.' },
    timezone: {
      type: 'string',
      maxLength: 100,
      description: 'emulate IANA timezone, e.g. Asia/Seoul; empty string clears.',
    },
    colorScheme: { type: 'string', enum: ['dark', 'light', 'auto'], description: 'emulate preferred color scheme.' },
    reducedMotion: { type: 'boolean', description: 'emulate prefers-reduced-motion.' },
    networkProfile: {
      type: 'string',
      enum: ['none', 'offline', 'slow3g', 'fast3g'],
      description: 'emulate a predefined network profile.',
    },
    cpuThrottlingRate: { type: 'number', minimum: 1, maximum: 20, description: 'emulate CPU slowdown factor.' },
    orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'emulate viewport orientation.' },
    reset: {
      type: 'boolean',
      description: 'emulate only: clear all emulation overrides before applying supplied settings.',
    },
    latitude: {
      type: 'number',
      minimum: -90,
      maximum: 90,
      description: 'emulate geolocation latitude; needs longitude.',
    },
    longitude: {
      type: 'number',
      minimum: -180,
      maximum: 180,
      description: 'emulate geolocation longitude; needs latitude.',
    },
    accuracy: {
      type: 'number',
      minimum: 1,
      maximum: 10000,
      description: 'emulate geolocation accuracy in metres; default 10.',
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description:
        'emulate: extra HTTP headers on every page request, replacing the previous set; Authorization covers basic auth.',
    },
    abort: { type: 'boolean', description: 'intercept add: refuse the match instead of answering it.' },
    body: {
      type: 'string',
      maxLength: 65536,
      description: "intercept add: payload replacing the response body; the status line stays the server's.",
    },
    ruleId: { type: 'string', maxLength: 100, description: 'intercept remove: i1/i2 from an intercept list.' },
    scriptId: { type: 'string', maxLength: 100, description: 'init_script remove: is1/is2 from an init_script list.' },
    reload: {
      type: 'boolean',
      description: 'navigate: reload the current page instead of url. performance start: reload once recording begins.',
    },
    saveTrace: {
      type: 'boolean',
      description: 'performance start only: keep a bounded, redacted trace and save its JSON when stopped.',
    },
    downloadId: {
      type: 'string',
      maxLength: 100,
      description:
        'downloads only: d1/d2 ID; omitted, wait pins the newest (or next) download and attach takes the newest completed file.',
    },
    wait: { type: 'boolean', description: 'downloads only: wait up to timeoutMs for completion.' },
    attach: { type: 'boolean', description: 'downloads only: attach the completed file (≤ 8 MiB) to the result.' },
    text: {
      type: 'string',
      maxLength: 100000,
      description: 'fill/type: replacement text. wait: page-text substring that must appear.',
    },
    textGone: { type: 'string', maxLength: 10000, description: 'wait: page-text substring that must disappear.' },
    submit: { type: 'boolean', description: 'fill or type: press Enter afterward.' },
    savedAccount: {
      type: 'string',
      maxLength: 320,
      description:
        'fill: account or masked label stored for this HTTPS site; fills the whole sign-in form. No ref/target/text; submit presses Enter. The password stays on the host.',
    },
    key: {
      type: 'string',
      maxLength: 100,
      description: 'press: a character, special key, or combo like Control+A or Meta+A.',
    },
    dx: { type: 'integer', description: 'scroll px horizontally; negative is left.' },
    dy: { type: 'integer', description: 'scroll px vertically; negative is up. Omit dx/dy for one viewport down.' },
    maxChars: {
      type: 'integer',
      minimum: 1,
      maximum: 30000,
      description:
        'Page-text cap; not locate/console (use limit). Defaults: snapshots 2400, read 8000, evaluate 12000, network 10000.',
    },
    offset: { type: 'integer', minimum: 0, description: 'read start character for paging through long text.' },
    query: {
      type: 'string',
      maxLength: 4096,
      description:
        'snapshot/read: keywords OR-match or /pattern/i. locate: visual text/color/position. network/console: case-insensitive substring (network ID, URL, method, type, MIME, status).',
    },
    viewportOnly: {
      type: 'boolean',
      description: 'Snapshot-bearing actions: only elements intersecting the viewport.',
    },
    maxElements: { type: 'integer', minimum: 1, maximum: 500, description: 'snapshot element cap; default 160.' },
    values: {
      type: 'array',
      items: { type: 'string', maxLength: 4096 },
      minItems: 1,
      maxItems: 100,
      description: 'select only: option values or labels.',
    },
    checked: { type: 'boolean', description: 'fill: checkbox/radio state for one control, instead of text.' },
    doubleClick: { type: 'boolean', description: 'click only: dispatch a double click.' },
    level: {
      type: 'string',
      enum: ['all', 'debug', 'info', 'warning', 'error'],
      description: 'console minimum level; default error.',
    },
    accept: { type: 'boolean', description: 'handle_dialog only: accept when true, dismiss when false.' },
    promptText: { type: 'string', maxLength: 10000, description: 'handle_dialog only: text for a prompt dialog.' },
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', maxLength: 128 },
          target: NESTED_TARGET_SCHEMA,
          text: { type: 'string', maxLength: 100000 },
          value: { type: 'string', maxLength: 100000 },
          values: { type: 'array', items: { type: 'string', maxLength: 4096 }, minItems: 1, maxItems: 100 },
          checked: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      description: 'fill batch: each item ref or target (one kind) plus exactly one of text/value, values, or checked.',
    },
    steps: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'fill', 'type', 'select', 'hover', 'press', 'scroll', 'wait'] },
          ref: { type: 'string', maxLength: 128 },
          target: NESTED_TARGET_SCHEMA,
          text: { type: 'string', maxLength: 100000 },
          values: { type: 'array', items: { type: 'string', maxLength: 4096 }, minItems: 1, maxItems: 100 },
          checked: { type: 'boolean' },
          key: { type: 'string', maxLength: 100 },
          submit: { type: 'boolean' },
          savedAccount: { type: 'string', maxLength: 320, description: 'fill: as input.savedAccount.' },
          dx: { type: 'integer' },
          dy: { type: 'integer' },
          textGone: { type: 'string', maxLength: 10000 },
          url: { type: 'string', maxLength: 8192 },
          timeoutMs: { type: 'integer' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      description:
        '2-6 steps, one final snapshot. select requires values; fill may use savedAccount; other targets use ref/target.',
    },
    paths: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string', maxLength: 32767 },
      description: 'upload: absolute paths; a non-file ref opens its chooser, no ref answers a pending one.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 500,
      maximum: 30000,
      description: 'wait/evaluate/downloads ceiling in ms; wait/evaluate default 10000/5000.',
    },
    expect: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          maxLength: 10000,
          description: 'Page text substring that must appear after the action.',
        },
        textGone: {
          type: 'string',
          maxLength: 10000,
          description: 'Page text substring that must disappear after the action.',
        },
        url: {
          type: 'string',
          maxLength: 10000,
          description: 'Final URL substring that must appear after the action; locale prefixes may change.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 500,
          maximum: 20000,
          description: 'Postcondition wait ceiling; default 5000.',
        },
      },
      additionalProperties: false,
      description:
        'State-changing actions only: verified once after dispatch, never replayed; failure returns an error with a fresh snapshot. Already true before dispatch = inconclusive.',
    },
    settleMs: {
      type: 'integer',
      minimum: 0,
      maximum: 5000,
      description: 'Delay before the final snapshot when a dynamic page has no deterministic postcondition.',
    },
    includeScreenshot: {
      type: 'boolean',
      description: 'State-changing actions: attach a screenshot bound to the fresh snapshotId.',
    },
    brief: {
      type: 'boolean',
      description: 'State-changing actions: only elements changed since the previous observation.',
    },
    tab: {
      type: 'string',
      maxLength: 64,
      description:
        'Session-local page ID p1/p2… from list_tabs (v1/v2 aliases work), or a background page name; background:true creates one. Popups are named background pages.',
    },
    background: {
      type: 'boolean',
      description:
        'true creates/targets a hidden support page; omitted never promotes a named support page; false temporarily reveals it. open without true retains the page for user handoff.',
    },
  },
};
