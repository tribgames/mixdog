#!/usr/bin/env node
/**
 * scripts/tui-frame-harness.mjs — renderer-level frame-grid evidence harness.
 *
 * Drives vendor/ink log-update createIncremental(fakeStream) through the SAME
 * wrapper logic ink.js renderInteractiveFrame() applies (fullscreen detect +
 * trailing-newline normalization + shouldClearTerminalForFrame), replays the
 * emitted ANSI into a minimal VT grid interpreter, and asserts the absolute row
 * of a tracked marker line (the "prompt" / "statusline") across each frame.
 *
 * A deviant frame = the marker's absolute row changes for a single frame then
 * snaps back. That is the one-row-low dip reported under Windows Terminal.
 *
 * Run: node scripts/tui-frame-harness.mjs
 */
// [harness] log-update reads process.platform/WT_SESSION AT IMPORT to pick its
// Windows-safe absolute-cursor branch. Force WT_SESSION on BEFORE importing it
// so POSIX/CI runs exercise the same branch WT users hit. Must precede the
// dynamic import below.
process.env.WT_SESSION = process.env.WT_SESSION || '1';
const { default: logUpdate } = await import('../vendor/ink/build/log-update.js');
const { shouldClearTerminalForFrameProbe } = await import('./tui-frame-harness-shim.mjs');
const { default: ansiEscapes } = await import('ansi-escapes');

// Fail loudly if the Windows-safe branch is NOT engaged: without it the harness
// silently tests the wrong path and reports a false pass. Probe by driving a
// fullscreen→one-short pair through a throwaway log and asserting the branch's
// absolute cursorTo(0,y) addressing (not a relative cursorUp walk) is emitted.
function assertWindowsBranchEngaged() {
  const chunks = [];
  const fs = { write: (s) => { chunks.push(s); return true; }, isTTY: true, columns: 20, rows: 4 };
  const log = logUpdate.create(fs, { incremental: true });
  log.sync('a\nb\nc\nd');            // 4 lines, fullscreen, no trailing nl
  chunks.length = 0;
  log('a\nX\nc\nd');                 // change one middle row, still fullscreen
  const emitted = chunks.join('');
  // Windows-safe branch uses absolute cursorTo(0, i) => CSI <row>;1H. The POSIX
  // relative branch uses cursorUp / cursorNextLine (CSI A / E) with no ;1H rows.
  const hasAbsolute = /\x1b\[\d+;1H/.test(emitted);
  if (!hasAbsolute) {
    console.error('tui-frame-harness: FAIL — log-update Windows-safe branch NOT engaged '
      + '(WT_SESSION/platform did not force it at import). Emitted:', JSON.stringify(emitted));
    process.exit(1);
  }
}
assertWindowsBranchEngaged();

// ---- Minimal VT grid interpreter -----------------------------------------
// Supports the escapes log-update / ink emit: cursorTo(x[,y]), cursorUp/Down/
// NextLine, eraseLine, eraseEndLine, eraseLines(n), clearTerminal, plain text,
// newline, SGR (ignored for geometry), hide/show cursor (ignored).
class VT {
  constructor(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => '');
    this.cx = 0;
    this.cy = 0;
  }
  _clampRow() { if (this.cy < 0) this.cy = 0; if (this.cy >= this.rows) this.cy = this.rows - 1; }
  write(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\u001B') {
        // CSI
        if (data[i + 1] === '[') {
          let j = i + 2;
          let params = '';
          while (j < data.length && /[0-9;]/.test(data[j])) { params += data[j]; j++; }
          const cmd = data[j];
          const nums = params.split(';').map((p) => (p === '' ? undefined : Number(p)));
          this._csi(cmd, nums, params);
          i = j + 1;
          continue;
        }
        // other escapes (e.g. \u001B[?25l already handled via '[' path); skip 2
        i += 1;
        continue;
      }
      if (ch === '\n') { this.cy += 1; this.cx = 0; this._clampRow(); i++; continue; }
      if (ch === '\r') { this.cx = 0; i++; continue; }
      // printable
      this._clampRow();
      const row = this.grid[this.cy];
      const padded = row.length < this.cx ? row + ' '.repeat(this.cx - row.length) : row;
      this.grid[this.cy] = padded.slice(0, this.cx) + ch + padded.slice(this.cx + 1);
      this.cx += 1;
      i++;
    }
  }
  _csi(cmd, nums, params) {
    const n = nums[0];
    switch (cmd) {
      case 'H': case 'f': { // cursor position (1-based row;col)
        this.cy = (nums[0] ?? 1) - 1; this.cx = (nums[1] ?? 1) - 1; this._clampRow(); break;
      }
      case 'A': this.cy -= (n ?? 1); this._clampRow(); break; // up
      case 'B': this.cy += (n ?? 1); this._clampRow(); break; // down
      case 'C': this.cx += (n ?? 1); break; // forward
      case 'D': this.cx -= (n ?? 1); if (this.cx < 0) this.cx = 0; break; // back
      case 'E': this.cy += (n ?? 1); this.cx = 0; this._clampRow(); break; // next line
      case 'F': this.cy -= (n ?? 1); this.cx = 0; this._clampRow(); break; // prev line
      case 'G': this.cx = (n ?? 1) - 1; break; // column (cursorTo(x) → \u001B[(x+1)G)
      case 'J': { // erase display; 2 = whole screen (clearTerminal uses 2J + H)
        if (n === 2 || n === 3) { this.grid = Array.from({ length: this.rows }, () => ''); }
        break;
      }
      case 'K': { // erase line (eraseEndLine=0/none; eraseLine full = 2K)
        if (n === undefined || n === 0) { this.grid[this.cy] = this.grid[this.cy].slice(0, this.cx); }
        else if (n === 1) { this.grid[this.cy] = ' '.repeat(this.cx) + this.grid[this.cy].slice(this.cx); }
        else if (n === 2) { this.grid[this.cy] = ''; }
        break;
      }
      // SGR (m), hide/show cursor (h/l), etc. — no geometry effect
      default: break;
    }
  }
  markerRow(marker) {
    for (let r = 0; r < this.rows; r++) {
      if (this.grid[r].includes(marker)) return r;
    }
    return -1;
  }
  dump() {
    return this.grid.map((r, i) => `${String(i).padStart(2)}|${r}`).join('\n');
  }
}

// ---- Wrapper mirroring ink.js renderInteractiveFrame ----------------------
function makeDriver({ rows, cols, isWindows }) {
  const chunks = [];
  const fakeStream = { write: (s) => { chunks.push(s); return true; }, isTTY: true, columns: cols, rows };
  // Force the incremental renderer's Windows branch by faking env/platform is
  // out of scope here; log-update reads process.platform/WT_SESSION at import.
  const log = logUpdate.create(fakeStream, { incremental: true });
  const vt = new VT(rows, cols);
  let lastOutput = '';
  let lastOutputHeight = 0;
  let lastViewportRows = rows;
  let lastOneShortPadded = false;
  const commit = (output) => {
    chunks.length = 0;
    // [FAITHFUL] outputHeight = output.get().height = Output.height = the
    // Yoga-computed ROOT height (renderer.js L45). The App pins the outer
    // column to height=resizeState.rows, so a steady frame reports height=rows.
    // BUT when the App's row accounting is off by one for a single commit
    // (a reclaimed panel/hint row not yet refilled), the root lays out at
    // rows-1 and outputHeight==rows-1. Model the height as the caller states
    // it via a marker: the frame string's real line count is authoritative
    // here because we construct each frame to physically carry `heightRows`
    // lines. So derive it from the string.
    const lineCount = output.split('\n').length;
    let outputHeight = output === '' ? 0 : lineCount;
    // Mirror ink.js (post-fix): an exactly-one-row-short frame following a
    // fullscreen frame is padded with a leading blank line so the bottom
    // cluster stays at its steady rows and the fullscreen path stays engaged.
    const wasFullscreenFrame = lastOutputHeight >= lastViewportRows && lastOutputHeight > 0;
    // Mirror ink.js guard exactly: Windows-like only + one-commit transient.
    const isExactlyOneRowShort = isWindows && outputHeight === rows - 1
      && wasFullscreenFrame && !lastOneShortPadded;
    if (isExactlyOneRowShort) {
      output = '\n' + output;
      outputHeight = rows;
      lastOneShortPadded = true;
    } else {
      lastOneShortPadded = false;
    }
    const isFullscreen = outputHeight >= rows;
    let outputToRender = isFullscreen ? output : output + '\n';
    if (isFullscreen && outputToRender.endsWith('\n')) outputToRender += '\u001B[0m';
    const clearDecision = shouldClearTerminalForFrameProbe({
      isTty: true, viewportRows: rows, previousViewportRows: lastViewportRows,
      previousOutputHeight: lastOutputHeight, nextOutputHeight: outputHeight,
      isUnmounting: false, isWindows,
    });
    if (clearDecision) {
      fakeStream.write('\u001B[0m' + ansiEscapes.clearTerminal + outputToRender);
      log.sync(outputToRender);
    } else {
      log(outputToRender);
    }
    for (const c of chunks) vt.write(c);
    lastOutput = output;
    lastOutputHeight = outputHeight;
    lastViewportRows = rows;
    const trailingNL = outputToRender.endsWith('\n');
    return { outputHeight, trailingNL, clearDecision, isFullscreen };
  };
  return { vt, commit };
}

// ---- Scenario builders ----------------------------------------------------
// Build an App-like frame with the prompt+statusline ALWAYS pinned to the two
// bottom-most non-blank rows (matching App.jsx: the bottom bar never moves).
// The App keeps total painted rows == viewport by ceding transcript rows to a
// panel; so the prompt row is invariant whether or not the palette is open.
// The only thing that changes between commits is: does the serialized output
// end on a blank row (→ trailing-newline flip, fs classification flip)?
// `bottomBlank` models a frame whose LAST painted row is blank padding.
// `shortByOne` = the root Yoga height is rows-1 for this commit (a reclaimed
// row that the App's accounting has NOT yet refilled). This is the documented
// deviant: outputHeight = rows-1 < viewportRows → ink.js takes output+'\n'
// (NON-fullscreen branch) → log-update relative cursorUp walk → one-row-low
// dip under Windows Terminal. A steady frame (shortByOne=false) fills the
// viewport, stays on the absolute cursorTo path, and is stable.
function frame({ rows, cols, palette, shortByOne, heightRows }) {
  // [FAITHFUL] App.jsx pins the bottom cluster with the outer full-height
  // column (height=resizeState.rows) + flexShrink={0} on the bottom bar. So the
  // Yoga root height is `rows` when accounting is correct. When a reclaimed row
  // is momentarily unaccounted, the laid-out tree is `rows-1` tall for one
  // commit — that is `shortByOne`. In that frame the WHOLE column (including
  // the pinned bottom cluster) sits one physical row higher.
  // heightRows (explicit) overrides shortByOne — lets a caller drive an
  // arbitrary frame height (e.g. rows-3) to exercise the real leave-fullscreen
  // shrink chain, which the boolean shortByOne cannot express.
  const height = heightRows != null ? heightRows : (shortByOne ? rows - 1 : rows);
  const statusRow = height - 1;
  const promptRow = statusRow - 1;
  const lines = [];
  for (let r = 0; r < height; r++) {
    if (r === statusRow) { lines.push('STATUSLINE'); continue; }
    if (r === promptRow) { lines.push('PROMPT>'); continue; }
    if (palette && r === promptRow - 1) { lines.push('SLASHPALETTE'); continue; }
    lines.push(`t${r}`);
  }
  // Serialized string carries exactly `height` lines (no trailing newline).
  return lines.join('\n');
}

function run() {
  const rows = 40, cols = 120;
  const isWindows = true;
  console.log(`# renderer harness rows=${rows} cols=${cols} isWindows(assumed)=${isWindows}`);
  console.log(`# NOTE: log-update Windows branch active iff process.platform===win32||WT_SESSION at import`);
  console.log(`#       (set WT_SESSION=1 to force it on non-Windows)\n`);

  // Each frame: { palette, shortByOne }. shortByOne=true is the ONE deviant
  // commit where the App's row accounting leaves the laid-out tree one row
  // short of the viewport (reclaimed panel/hint row not yet refilled).
  const scenarios = [
    { name: 'palette close, always viewport-filling (correct accounting)', seq: [
      { palette: true,  shortByOne: false },
      { palette: false, shortByOne: false },
      { palette: false, shortByOne: false },
    ]},
    { name: 'palette close, close commit ONE ROW SHORT (deviant accounting)', seq: [
      { palette: true,  shortByOne: false },
      { palette: false, shortByOne: true  },  // reclaimed row unaccounted
      { palette: false, shortByOne: false },
    ]},
    { name: 'prompt newline remove, transitional ONE ROW SHORT', seq: [
      { palette: false, shortByOne: false },
      { palette: false, shortByOne: true  },
      { palette: false, shortByOne: false },
    ]},
    // Steady one-short: repeated rows-1 frames. The pad must fire ONCE then
    // stop (lastOneShortPadded), so f2/f3 are NOT re-padded and settle at the
    // rows-1 layout (prompt rows-3 / status rows-2) with correct clear
    // decisions — no infinite downward shift.
    { name: 'steady ONE ROW SHORT (repeated rows-1) — pad once, then stop', seq: [
      { palette: false, shortByOne: false },
      { palette: false, shortByOne: true  },
      { palette: false, shortByOne: true  },
      { palette: false, shortByOne: true  },
    ]},
    // Real leave-fullscreen shrink chain rows→rows-1→rows-3: after the padded
    // rows-1 frame, a further shrink to rows-3 must reach the shrink/clear path
    // (not be masked by a stale pad) and settle cleanly.
    { name: 'real shrink chain fullscreen→rows-1→rows-3', seq: [
      { palette: false, heightRows: 40 },
      { palette: false, heightRows: 39 },
      { palette: false, heightRows: 37 },
      { palette: false, heightRows: 37 },
    ]},
  ];

  let anyDeviant = false;
  for (const sc of scenarios) {
    const { vt, commit } = makeDriver({ rows, cols, isWindows });
    const promptRows = [];
    console.log(`## ${sc.name}`);
    sc.seq.forEach((f, idx) => {
      const out = frame({ rows, cols, palette: f.palette, shortByOne: f.shortByOne, heightRows: f.heightRows });
      const info = commit(out);
      const pRow = vt.markerRow('PROMPT>');
      const sRow = vt.markerRow('STATUSLINE');
      promptRows.push(pRow);
      console.log(`  f${idx} short1=${f.shortByOne?1:0} h=${info.outputHeight} fs=${info.isFullscreen?1:0} trailNL=${info.trailingNL?1:0} clear=${info.clearDecision?1:0} promptRow=${pRow} statusRow=${sRow}`);
    });
    // Deviant = the prompt row BOUNCES (differs from the settled row for a
    // transient frame then returns). A monotone shift to a new steady row
    // (steady-one-short, real shrink) is NOT a bounce — check the LAST row is
    // reached and held, and no interior frame differs from BOTH neighbors.
    const settled = promptRows[promptRows.length - 1];
    const bounce = promptRows.some((r, i) =>
      i > 0 && i < promptRows.length - 1 &&
      r >= 0 && r !== promptRows[i - 1] && r !== promptRows[i + 1]);
    if (bounce) { anyDeviant = true; console.log(`  >> DEVIANT(bounce): prompt rows ${JSON.stringify(promptRows)} vs settled ${settled}`); }
    console.log('');
  }
  if (!anyDeviant) console.log('# no deviant frame reproduced at renderer level for these scenarios');
  process.exitCode = 0;
}

run();
