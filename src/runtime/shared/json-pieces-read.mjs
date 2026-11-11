/**
 * Reads a JSON file into the value `JSON.parse(readFileSync(file, 'utf8'))`
 * gives, a piece at a time: the file is read in blocks, the containers down to
 * `pieceDepth` are built here, and every value at that depth (and every scalar
 * above it) is parsed by JSON.parse from its own text. The longest string held
 * is one such piece, never the document: in Electron's Node every isolate
 * shares one 4 GB pointer-compression cage, and one 66M-char string for a
 * code-graph entry is the allocation that aborted the daemon when it was
 * written (b686de38b). jsonPieces of atomic-file.mjs writes the same pieces.
 *
 * What JSON.parse rejects throws here too: the separators between pieces are
 * checked as strictly as the pieces are, so a BOM, a trailing comma, a missing
 * member or text after the root is never read as a document.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

const isSpace = (code) => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
const endsLiteral = (code) => isSpace(code) || code === COMMA || code === COLON || code === CLOSE_ARRAY || code === CLOSE_OBJECT;

// JSON.parse makes "__proto__" an own property; an assignment would not.
function put(object, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  } else object[key] = value;
}

class PieceParser {
  constructor(pieceDepth) {
    this.pieceDepth = pieceDepth;
    this.frames = []; // containers built here: { array, value, key, state }
    this.buf = '';
    this.pos = 0; // the next unread character of buf
    this.consumed = 0; // characters before buf
    this.piece = null; // the piece being read: { kind, key, scanned, nest, inString, escaped }
    this.root = undefined;
    this.done = false;
  }

  fail() {
    throw new SyntaxError(`Unexpected token in JSON at position ${this.consumed + this.pos}`);
  }

  feed(text) {
    this.buf = this.pos < this.buf.length ? this.buf.slice(this.pos) + text : text;
    this.consumed += this.pos;
    this.pos = 0;
    this.run(false);
  }

  finish() {
    this.run(true);
    if (!this.done) this.fail();
    return this.root;
  }

  deliver(value) {
    const top = this.frames.at(-1);
    if (!top) {
      this.root = value;
      this.done = true;
      return;
    }
    if (top.array) top.value.push(value);
    else put(top.value, top.key, value);
    top.state = 'comma';
  }

  startPiece(code, key) {
    const kind = code === OPEN_OBJECT || code === OPEN_ARRAY ? 'container' : code === QUOTE ? 'string' : 'literal';
    this.piece = { kind, key, scanned: 0, nest: 0, inString: false, escaped: false };
  }

  // Extends the piece over buf; true when it ended (and was delivered).
  advancePiece(final) {
    const piece = this.piece;
    const { buf } = this;
    const start = this.pos;
    let at = start + piece.scanned;
    let end = -1;
    if (piece.kind === 'literal') {
      while (at < buf.length && !endsLiteral(buf.charCodeAt(at))) at += 1;
      if (at < buf.length || final) end = at;
    } else {
      while (at < buf.length && end < 0) {
        if (piece.inString) {
          // Most of a piece is string text: jump to its next quote, which
          // closes the string unless an odd run of backslashes escapes it.
          if (piece.escaped) {
            piece.escaped = false;
            at += 1;
            continue;
          }
          const quote = buf.indexOf('"', at);
          const stop = quote < 0 ? buf.length : quote;
          let run = stop;
          while (run > at && buf.charCodeAt(run - 1) === BACKSLASH) run -= 1;
          const escaping = (stop - run) % 2 === 1;
          if (quote < 0) piece.escaped = escaping;
          else if (!escaping) {
            piece.inString = false;
            if (piece.kind === 'string') end = quote + 1;
          }
          at = stop + (quote < 0 ? 0 : 1);
          continue;
        }
        const code = buf.charCodeAt(at);
        at += 1;
        if (code === QUOTE) piece.inString = true;
        else if (code === OPEN_OBJECT || code === OPEN_ARRAY) piece.nest += 1;
        else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
          piece.nest -= 1;
          if (piece.nest === 0) end = at;
        }
      }
    }
    if (end < 0) {
      piece.scanned = at - start;
      return false;
    }
    const value = JSON.parse(buf.slice(start, end));
    this.pos = end;
    this.piece = null;
    if (piece.key) {
      this.frames.at(-1).key = value;
      this.frames.at(-1).state = 'colon';
    } else this.deliver(value);
    return true;
  }

  closeFrame(code) {
    const top = this.frames.at(-1);
    if (code !== (top.array ? CLOSE_ARRAY : CLOSE_OBJECT)) this.fail();
    this.frames.pop();
    this.pos += 1;
    this.deliver(top.value);
  }

  run(final) {
    for (;;) {
      if (this.piece) {
        if (!this.advancePiece(final)) return;
        continue;
      }
      const { buf } = this;
      while (this.pos < buf.length && isSpace(buf.charCodeAt(this.pos))) this.pos += 1;
      if (this.pos >= buf.length) return;
      const code = buf.charCodeAt(this.pos);
      const top = this.frames.at(-1);
      if (!top) {
        if (this.done) this.fail();
        this.value(code);
      } else if (top.state === 'colon') {
        if (code !== COLON) this.fail();
        this.pos += 1;
        top.state = 'member';
      } else if (top.state === 'comma') {
        if (code === COMMA) {
          this.pos += 1;
          top.state = 'next';
        } else this.closeFrame(code);
      } else if (top.state === 'first' && (code === CLOSE_ARRAY || code === CLOSE_OBJECT)) {
        this.closeFrame(code);
      } else if (top.array || top.state === 'member') {
        this.value(code);
      } else {
        // An object's key.
        if (code !== QUOTE) this.fail();
        this.startPiece(code, true);
      }
    }
  }

  // A value starts at buf[pos]: a container built here, or a piece parsed whole.
  value(code) {
    if ((code === OPEN_OBJECT || code === OPEN_ARRAY) && this.frames.length < this.pieceDepth) {
      const array = code === OPEN_ARRAY;
      this.frames.push({ array, value: array ? [] : {}, key: null, state: 'first' });
      this.pos += 1;
      return;
    }
    if (code === CLOSE_ARRAY || code === CLOSE_OBJECT || code === COMMA || code === COLON) this.fail();
    this.startPiece(code, false);
  }
}

/** The value `JSON.parse(readFileSync(file, 'utf8'))` returns, and the length
 *  of that text in characters, read `chunkBytes` at a time. Throws what the
 *  read or the parse throws. */
export function readJsonFilePiecesSync(file, { pieceDepth = 2, chunkBytes = 1 << 20 } = {}) {
  const fd = openSync(file, 'r');
  try {
    const parser = new PieceParser(pieceDepth);
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const got = readSync(fd, chunk, 0, chunkBytes, null);
      if (got === 0) break;
      parser.feed(decoder.write(chunk.subarray(0, got)));
    }
    parser.feed(decoder.end());
    const value = parser.finish();
    return { value, chars: parser.consumed + parser.pos };
  } finally {
    closeSync(fd);
  }
}
