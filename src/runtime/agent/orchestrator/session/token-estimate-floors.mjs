// Exact auxiliary floors for the token estimator, computed by single
// charCodeAt scans that allocate nothing. Each scanner reproduces, code unit
// for code unit, the regular expression it replaced (named above each one);
// the differential tests pin them against those expressions.

// RegExp `\s` and String#trim whitespace: WhiteSpace + LineTerminator.
function isWhitespace(c) {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  if (c < 0xa0) return false;
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

// Characters RegExp `.` refuses to match (a `\n` never occurs inside a line).
function isLineTerminator(c) {
  return c === 0x0d || c === 0x2028 || c === 0x2029;
}

function isStructural(c) {
  // [ ] { } " : , = < > | \
  return (
    c === 0x5b ||
    c === 0x5d ||
    c === 0x7b ||
    c === 0x7d ||
    c === 0x22 ||
    c === 0x3a ||
    c === 0x2c ||
    c === 0x3d ||
    c === 0x3c ||
    c === 0x3e ||
    c === 0x7c ||
    c === 0x5c
  );
}

const UNDERSCORE = 0x5f;

// Dense runs: /[\x21-\x7e]{16,}/g, each run priced by its length.
// Encoded words: /\b(?=[A-Za-z0-9]{8,}\b)(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g
// matches exactly the maximal alphanumeric runs of 8+ characters holding a
// letter and a digit whose neighbours are not `_` (the only other `\w`).
export function denseTokenFloor(s) {
  const length = s.length;
  let floor = 0;
  let denseRun = 0;
  let wordStart = -1;
  let wordLetter = false;
  let wordDigit = false;
  let encodedWords = 0;
  let encodedChars = 0;
  for (let index = 0; index <= length; index += 1) {
    const c = index < length ? s.charCodeAt(index) : -1;
    if (c >= 0x21 && c <= 0x7e) {
      denseRun += 1;
    } else if (denseRun) {
      if (denseRun >= 16) floor += denseRun * (denseRun >= 64 ? 0.65 : 0.5);
      denseRun = 0;
    }
    const digit = c >= 0x30 && c <= 0x39;
    const letter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (digit || letter) {
      if (wordStart < 0) {
        wordStart = index;
        wordLetter = false;
        wordDigit = false;
      }
      wordLetter ||= letter;
      wordDigit ||= digit;
    } else if (wordStart >= 0) {
      if (
        index - wordStart >= 8 &&
        wordLetter &&
        wordDigit &&
        c !== UNDERSCORE &&
        (wordStart === 0 || s.charCodeAt(wordStart - 1) !== UNDERSCORE)
      ) {
        encodedWords += 1;
        encodedChars += index - wordStart;
      }
      wordStart = -1;
    }
  }
  if (encodedWords >= 3) {
    floor = Math.max(floor, encodedChars * 0.5 + (length - encodedChars) * 0.25);
  }
  return floor;
}

// Lines: s.split(/\r?\n/) keeping those with line.trim(); a line is JSON-like
// when it matches /^\s*[[{].*[\]}],?\s*$/. Non-whitespace counts /\S/ code
// units and structural counts /[[\]{}":,=<>|\\]/ code units. Splitting on
// `\n` alone is equivalent: the `\r` of a CRLF is trailing whitespace.
export function structuredTokenFloor(s) {
  const length = s.length;
  let lines = 0;
  let jsonLikeLines = 0;
  let nonWhitespace = 0;
  let structural = 0;
  let first = -1; // first non-whitespace index of the current line
  let last = -1; // last non-whitespace index of the current line
  let pendingTerminator = false; // a `.`-breaking terminator after `first`
  let innerTerminator = false; // ...followed by more non-whitespace
  for (let index = 0; index <= length; index += 1) {
    const c = index < length ? s.charCodeAt(index) : 0x0a;
    if (c === 0x0a) {
      if (first >= 0) {
        lines += 1;
        const open = s.charCodeAt(first);
        let close = s.charCodeAt(last);
        if (close === 0x2c && last - 1 > first) close = s.charCodeAt(last - 1);
        if ((open === 0x5b || open === 0x7b) && (close === 0x5d || close === 0x7d) && !innerTerminator) {
          jsonLikeLines += 1;
        }
      }
      first = -1;
      last = -1;
      pendingTerminator = false;
      innerTerminator = false;
      continue;
    }
    if (isWhitespace(c)) {
      if (first >= 0 && isLineTerminator(c)) pendingTerminator = true;
      continue;
    }
    nonWhitespace += 1;
    if (isStructural(c)) structural += 1;
    if (first < 0) first = index;
    else if (pendingTerminator) innerTerminator = true;
    last = index;
  }
  // None of the structured-text conditions can apply to fewer than three
  // nonblank lines.
  if (lines < 3 || nonWhitespace === 0) return 0;
  return jsonLikeLines >= Math.ceil(lines / 2) || structural / nonWhitespace >= 0.12
    ? nonWhitespace * 0.5 + (length - nonWhitespace) * 0.25
    : 0;
}
