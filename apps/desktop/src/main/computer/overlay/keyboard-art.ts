/**
 * The keyboard the user sees while an agent types. A keystroke carries no
 * screen position, so there is nothing for the pointer to travel to; this board
 * gives those keys a place of their own instead of leaving the cursor parked on
 * whatever it clicked last.
 *
 * What it must never do is echo a secret. When the focused field masks its
 * content, or the host cannot tell whether it does, the board still shows that
 * typing is happening but lights no key at all.
 */
export const KEYBOARD_WIDTH = 496;
export const KEYBOARD_HEIGHT = 186;

/** Rows as they sit under the fingers; `[cap, id, width]`, width in key units. */
const ROWS: Array<Array<[string, string, number?]>> = [
  [
    ['`', '`'],
    ['1', '1'],
    ['2', '2'],
    ['3', '3'],
    ['4', '4'],
    ['5', '5'],
    ['6', '6'],
    ['7', '7'],
    ['8', '8'],
    ['9', '9'],
    ['0', '0'],
    ['-', '-'],
    ['=', '='],
    ['⌫', 'backspace', 2],
  ],
  [
    ['⇥', 'tab', 1.5],
    ['Q', 'q'],
    ['W', 'w'],
    ['E', 'e'],
    ['R', 'r'],
    ['T', 't'],
    ['Y', 'y'],
    ['U', 'u'],
    ['I', 'i'],
    ['O', 'o'],
    ['P', 'p'],
    ['[', '['],
    [']', ']'],
    ['\\', '\\', 1.5],
  ],
  [
    ['⇪', 'capslock', 1.8],
    ['A', 'a'],
    ['S', 's'],
    ['D', 'd'],
    ['F', 'f'],
    ['G', 'g'],
    ['H', 'h'],
    ['J', 'j'],
    ['K', 'k'],
    ['L', 'l'],
    [';', ';'],
    ["'", "'"],
    ['⏎', 'enter', 2.2],
  ],
  [
    ['⇧', 'shift', 2.4],
    ['Z', 'z'],
    ['X', 'x'],
    ['C', 'c'],
    ['V', 'v'],
    ['B', 'b'],
    ['N', 'n'],
    ['M', 'm'],
    [',', ','],
    ['.', '.'],
    ['/', '/'],
    ['⇧', 'shift', 2.6],
  ],
  [
    ['Ctrl', 'ctrl', 1.6],
    ['Win', 'win', 1.2],
    ['Alt', 'alt', 1.2],
    ['', 'space', 6.4],
    ['Alt', 'alt', 1.2],
    ['Ctrl', 'ctrl', 1.6],
    ['Esc', 'escape', 1.8],
  ],
];

export function keyboardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#board{--accent:#58a6ff;--glow:color-mix(in srgb,var(--accent) 45%,transparent);box-sizing:border-box;width:100%;height:100%;padding:10px;display:flex;flex-direction:column;gap:4px;border-radius:14px;background:#0d1726e0;border:1px solid #ffffff1f;box-shadow:0 8px 28px #04070cb3,inset 0 1px 0 #ffffff14;opacity:0;transition:opacity 120ms linear}
#board.visible{opacity:1}
.row{display:flex;gap:4px;flex:1}
.key{flex:1 1 0;display:flex;align-items:center;justify-content:center;border-radius:5px;background:#ffffff0f;border:1px solid #ffffff17;color:#c6d4e6;font:600 10px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.02em;transition:background 90ms linear,color 90ms linear,box-shadow 90ms linear}
.key.down{background:var(--accent);border-color:color-mix(in srgb,var(--accent) 70%,white);color:#04101d;box-shadow:0 0 12px var(--glow),0 0 0 1px var(--glow)}
/* A masked field never lights a key. The board breathes instead, so the user
   still sees that typing is happening without seeing what is typed. */
#board.masked{animation:breathe 1400ms ease-in-out infinite}
#board.masked .key.down{background:#ffffff0f;border-color:#ffffff17;color:#c6d4e6;box-shadow:none}
@keyframes breathe{0%,100%{box-shadow:0 8px 28px #04070cb3,inset 0 1px 0 #ffffff14}50%{box-shadow:0 8px 28px #04070cb3,inset 0 1px 0 #ffffff14,0 0 0 1px var(--glow),0 0 18px var(--glow)}}
@media(prefers-reduced-motion:reduce){#board{transition:none}#board.masked{animation:none}.key{transition:none}}
</style></head><body><div id="board" aria-hidden="true"></div></body></html>`;
}

export function keyboardScript(): string {
  return `(() => {
    const rows = ${JSON.stringify(ROWS)};
    const board = document.getElementById('board');
    const byId = new Map();
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'row';
      for (const [cap, id, width] of row) {
        const key = document.createElement('div');
        key.className = 'key';
        key.textContent = cap;
        key.style.flexGrow = String(width || 1);
        line.appendChild(key);
        const existing = byId.get(id);
        if (existing) existing.push(key);
        else byId.set(id, [key]);
      }
      board.appendChild(line);
    }
    let clearTimer;
    // Names the host sends that do not match a cap directly.
    // A name maps to one key, or to the keys a finger really presses for it.
    const aliases = {
      return: 'enter', esc: 'escape', del: 'backspace', delete: 'backspace',
      control: 'ctrl', meta: 'win', super: 'win', cmd: 'win', command: 'win',
      ' ': 'space', spacebar: 'space', multiply: '8', subtract: '-',
      '+': ['shift', '='], plus: ['shift', '='], add: ['shift', '='],
    };
    const lift = () => {
      for (const keys of byId.values()) {
        for (const key of keys) key.classList.remove('down');
      }
    };
    window.mixdogAgentKeyboard = state => {
      board.style.setProperty('--accent', state.accent || '#58a6ff');
      board.classList.toggle('masked', state.masked === true);
      board.className = board.className.includes('visible') ? board.className : board.className + ' visible';
      clearTimeout(clearTimer);
      lift();
      // A masked field is told only that input is flowing, never which keys.
      if (state.masked === true) return;
      for (const raw of state.keys || []) {
        const name = String(raw).toLowerCase();
        const mapped = aliases[name] || name;
        for (const id of Array.isArray(mapped) ? mapped : [mapped]) {
          for (const key of byId.get(id) || []) key.classList.add('down');
        }
      }
      clearTimer = setTimeout(lift, 220);
    };
  })();`;
}
