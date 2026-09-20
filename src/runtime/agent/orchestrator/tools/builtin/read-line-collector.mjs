// Line collector of one streamed read range. Owns the line cursor, the
// partial line that spans chunk boundaries (capped at
// READ_MAX_LINE_COLLECT_BYTES) and the rendered window, and stops at the
// output byte budget or the line limit.
import { READ_MAX_LINE_COLLECT_BYTES } from './read-constants.mjs';
import { renderReadLine } from './read-formatting.mjs';
import { maybeRecordReadRangeAnchor } from './read-range-index.mjs';

export function createReadLineCollector({ offset, limit, bodyOutputBytes, rangeIndex, startLine }) {
  const collected = [];
  let lineIdx = startLine;
  let currentLineBytes = 0;
  let collectedBytes = 0;
  let truncated = false;
  let stoppedAtLimit = false;
  let firstEmitted = 0;
  let lastEmitted = 0;
  let pendingParts = [];
  let pendingBytes = 0;
  let lineCollectCapped = false;

  const shouldCollectLine = () => lineIdx >= offset && collected.length < limit;

  const renderLine = (lineBuf) => {
    if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 13) {
      lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
    }
    let line = lineBuf.toString('utf-8');
    if (lineIdx === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    // Per-line truncation mirrors the non-streamed path
    // (read-formatting.renderReadLine): a single multi-MB line
    // would otherwise blow past READ_MAX_OUTPUT_BYTES on its
    // own and force the whole window to truncate. renderReadLine
    // applies the same head/tail cap and "[line truncated]"
    // marker so the rendered byte count stays bounded.
    const rendered = renderReadLine(lineIdx + 1, line);
    // Cap is byte-oriented (READ_MAX_OUTPUT_BYTES). String .length counts
    // UTF-16 code units and underestimates bytes for non-ASCII output, so
    // measure with Buffer.byteLength to keep the rendered slice <= cap.
    // Truncation drops the entire rendered line (codepoint-safe by
    // construction), so no mid-codepoint cut can occur here.
    collectedBytes += Buffer.byteLength(rendered, 'utf8') + 1;
    if (collectedBytes > bodyOutputBytes) {
      truncated = true;
      return false;
    }
    collected.push(rendered);
    if (firstEmitted === 0) firstEmitted = lineIdx + 1;
    lastEmitted = lineIdx + 1;
    return true;
  };

  // The complete bytes of the line being finished: pending parts from earlier
  // chunks plus the final segment, capped at READ_MAX_LINE_COLLECT_BYTES.
  const completeLineBytes = (finalSegment) => {
    const finalLen = finalSegment ? finalSegment.length : 0;
    if (lineCollectCapped) {
      const lineBuf = Buffer.concat(pendingParts, pendingBytes);
      return Buffer.from(lineBuf.toString('utf-8').slice(0, READ_MAX_LINE_COLLECT_BYTES));
    }
    if (pendingParts.length === 0) return finalSegment || Buffer.alloc(0);
    if (finalLen > 0 && pendingBytes + finalLen <= READ_MAX_LINE_COLLECT_BYTES) {
      return Buffer.concat([...pendingParts, finalSegment], pendingBytes + finalLen);
    }
    if (finalLen > 0) {
      const room = Math.max(0, READ_MAX_LINE_COLLECT_BYTES - pendingBytes);
      return room > 0
        ? Buffer.concat(
            [...pendingParts, finalSegment.subarray(0, Math.min(room, finalLen))],
            pendingBytes + Math.min(room, finalLen)
          )
        : Buffer.concat(pendingParts, pendingBytes);
    }
    return Buffer.concat(pendingParts, pendingBytes);
  };

  const advanceLine = (nextLineStartByte) => {
    lineIdx++;
    if (nextLineStartByte !== null) maybeRecordReadRangeAnchor(rangeIndex, lineIdx, nextLineStartByte);
    currentLineBytes = 0;
  };

  return {
    get lineIdx() {
      return lineIdx;
    },
    get count() {
      return collected.length;
    },
    get firstEmitted() {
      return firstEmitted;
    },
    get lastEmitted() {
      return lastEmitted;
    },
    // Bytes of an unterminated line seen while seeking to the window.
    notePartial(byteCount) {
      currentLineBytes += byteCount;
    },
    // A line before the window: advance the cursor and record its anchor.
    skipLine(nextLineStartByte) {
      advanceLine(nextLineStartByte);
    },
    // Complete the current line with `finalSegment`. Returns false once the
    // window is full (output budget or line limit) and reading must stop.
    finishLine(finalSegment = null, nextLineStartByte = null) {
      if (finalSegment) currentLineBytes += finalSegment.length;
      if (shouldCollectLine()) {
        const lineBuf = completeLineBytes(finalSegment);
        pendingParts = [];
        pendingBytes = 0;
        lineCollectCapped = false;
        if (!renderLine(lineBuf)) return false;
        if (Number.isFinite(limit) && collected.length >= limit) {
          stoppedAtLimit = true;
          advanceLine(nextLineStartByte);
          return false;
        }
      } else {
        pendingParts = [];
        pendingBytes = 0;
      }
      advanceLine(nextLineStartByte);
      return true;
    },
    // Trailing bytes of a chunk that did not end the line yet.
    appendPartial(segment) {
      currentLineBytes += segment.length;
      if (!shouldCollectLine() || segment.length === 0) return;
      if (pendingBytes >= READ_MAX_LINE_COLLECT_BYTES) {
        lineCollectCapped = true;
        return;
      }
      const room = READ_MAX_LINE_COLLECT_BYTES - pendingBytes;
      const take = Math.min(segment.length, room);
      if (take > 0) {
        pendingParts.push(Buffer.from(segment.subarray(0, take)));
        pendingBytes += take;
      }
      if (take < segment.length) lineCollectCapped = true;
    },
    // The final unterminated line, if any bytes were seen for it.
    finishTail() {
      if (currentLineBytes > 0) this.finishLine();
    },
    // Rendered window plus the continuation/empty-range marker.
    text({ maxOutputBytes, readOffsetBase }) {
      let out = collected.join('\n');
      if (truncated) {
        const nextOffset = (lastEmitted || offset) + readOffsetBase;
        out += `\n\n... [output truncated at ${Math.max(1, Math.round(maxOutputBytes / 1024))} KB; pass offset:${nextOffset} to continue] ...`;
      } else if (stoppedAtLimit) {
        out += `${out ? '\n' : ''}... [range limit reached; next offset: ${offset + collected.length + readOffsetBase}]`;
      } else if (!out && offset >= lineIdx) {
        out = `(no lines in range; file has ${lineIdx} lines)`;
      }
      return out;
    },
  };
}
