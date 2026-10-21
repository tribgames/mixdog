/**
 * The text a restored user bubble shows for a stored prompt, matching what the
 * live bubble showed for it:
 * - An image part is drawn by the `[Image: …]` metadata line the composer put
 *   before it; the part itself adds no raw `[image: image/png]` marker (a bare
 *   one gets a metadata line of its own, which renders as an image chip).
 * - A desktop `<visualize_feedback>` block (the agent-facing pin/choice
 *   record) is shown as the lines the live bubble showed: `📌 N · label —
 *   note` per pin, one `☑ group: label, …` line for the picks and one
 *   `🎚 id: value (was old), …` line for tweaks (drawn with an icon). Intake
 *   moves a long block into the attachment store; it is read back from there.
 */
import { isAttachmentReference, readAttachmentTextWithin } from '../../../../attachments/store.mjs';
import { isMediaReferencePart } from '../../../../attachments/attachment-reference.mjs';
import { toolResultText } from './tool-result-text.mjs';

const IMAGE_METADATA_LINE = /\[Image(?::| source:) [^\]\r\n]+\]\s*$/;
const FEEDBACK_OPEN = '<visualize_feedback>';
const FEEDBACK_BLOCK = /<visualize_feedback>\n([\s\S]*?)\n?<\/visualize_feedback>/g;
// Feedback blocks are bounded (20 pins, trimmed HTML); a larger blob is a long
// prompt or paste, which restores as before without being read. The cap holds
// on the blob itself: the reference's claimed sizeBytes is not trusted.
const FEEDBACK_MAX_BYTES = 128 * 1024;
const QUOTED = '("(?:[^"\\\\]|\\\\.)*")';
const CHOICE_LINE = new RegExp(`· group: (?:${QUOTED}|\\(none\\)) → choice: ${QUOTED}(?: \\(${QUOTED}\\))?$`);

function unquote(value) {
  if (!value) return '';
  try {
    return String(JSON.parse(value));
  } catch {
    return '';
  }
}

/** The live bubble's lines for one feedback block body. */
function feedbackDisplay(body) {
  const pins = [];
  const choices = [];
  let pin = null;
  let note = false;
  let inChoices = false;
  const tweakSets = [];
  let tweaks = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('tweaks (')) {
      pin = null;
      inChoices = false;
      tweaks = null;
      tweakSets.push([]);
      tweaks = tweakSets.at(-1);
      continue;
    }
    if (tweaks) {
      const change = /^ {4}(.+?) \([^)]*\): (.*) \(was (.*)\)$/.exec(line);
      if (change) tweaks.push(`${change[1]}: ${change[2]} (was ${change[3]})`);
      else if (line.startsWith('  - tab: ')) {
        tweaks = [];
        tweakSets.push(tweaks);
      } else tweaks = null;
      if (tweaks) continue;
    }
    const head = /^pin (\d+) · (.*)$/.exec(line);
    if (head) {
      pin = { n: head[1], label: head[2], note: '' };
      pins.push(pin);
      note = false;
      inChoices = false;
      continue;
    }
    if (line === 'choices:') {
      pin = null;
      inChoices = true;
      continue;
    }
    if (pin && line.startsWith('  note: ')) {
      pin.note = line.slice(8);
      note = true;
      continue;
    }
    if (pin && note && line.startsWith('    ')) {
      pin.note += `\n${line.slice(4)}`;
      continue;
    }
    note = false;
    const choice = inChoices ? CHOICE_LINE.exec(line) : null;
    if (choice) {
      choices.push({ group: unquote(choice[1]), choice: unquote(choice[2]), label: unquote(choice[3]) });
    }
  }
  const lines = pins.map((entry) => `📌 ${entry.n} · ${entry.label} — ${entry.note.replace(/\s+/g, ' ')}`);
  if (choices.length) {
    lines.push(
      `☑ ${choices.map((entry) => (entry.group ? `${entry.group}: ` : '') + (entry.label || entry.choice)).join(', ')}`
    );
  }
  const changed = tweakSets.filter((set) => set.length).map((set) => set.join(', '));
  if (changed.length) lines.push(`🎚 ${changed.join('; ')}`);
  return lines.join('\n');
}

export function withVisualizeFeedbackDisplay(text) {
  const value = String(text ?? '');
  if (!value.includes(FEEDBACK_OPEN)) return value;
  return value.replace(FEEDBACK_BLOCK, (_block, body) => feedbackDisplay(body));
}

/** A stored text reference's body when it is a feedback block, else ''. */
function referencedFeedbackText(part) {
  if (part?.type !== 'text' || part.textKind) return '';
  try {
    const text = readAttachmentTextWithin(part, FEEDBACK_MAX_BYTES);
    return text?.startsWith(FEEDBACK_OPEN) ? text : '';
  } catch {
    // A blob gone from the store restores as it always did: without its text.
    return '';
  }
}

const PASTED_LINES = /· (\d+) lines?$/;
const PASTED_TEXT_MAX_BYTES = 1024 * 1024;
/** Blob bytes one transcript load may read to count the lines of pastes
 *  whose stored name does not carry the count (pastes stored before it did). */
export const PASTED_LINE_READ_BUDGET_BYTES = 4 * 1024 * 1024;

/** A stored plain-text prompt part's text within the load's byte budget, else ''. */
function offloadedPromptText(part, budget) {
  const allowance = Math.min(PASTED_TEXT_MAX_BYTES, budget.remaining);
  if (allowance <= 0) return '';
  try {
    const text = readAttachmentTextWithin(part, allowance);
    if (text == null) return '';
    budget.remaining -= Buffer.byteLength(text, 'utf8');
    return text;
  } catch (error) {
    if (error?.code !== 'ENOENT') budget.remaining -= allowance;
    return '';
  }
}

/** Visible lines of a stored paste (as `pastedTextLineCount` counts them), or
 *  null when the count would take a read past the load's budget. */
function storedPasteLines(part, budget) {
  const named = PASTED_LINES.exec(String(part.filename || ''));
  if (named) return Number(named[1]);
  const allowance = Math.min(PASTED_TEXT_MAX_BYTES, budget.remaining);
  if (allowance <= 0) return null;
  try {
    const read = readAttachmentTextWithin(part, allowance);
    if (read == null) return null;
    budget.remaining -= Buffer.byteLength(read, 'utf8');
    const value = read.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    return value ? value.split('\n').length : 0;
  } catch (error) {
    // A blob that failed its integrity check was read before it failed: the
    // read counts against the cap (at most the allowance). A missing blob
    // read nothing.
    if (error?.code !== 'ENOENT') budget.remaining -= allowance;
    return null;
  }
}

/** The chip token a stored pasted / attached text stood for in the live
 *  bubble (intake moved its body into the store and dropped the token). A
 *  paste whose line count is unknown shows as the plain `[Pasted text #n]`. */
function storedTextToken(part, number, budget) {
  if (part?.type !== 'text') return '';
  if (part.textKind === 'paste') {
    const lines = storedPasteLines(part, budget);
    return lines == null ? `[Pasted text #${number}]` : `[Pasted text #${number} +${lines} lines]`;
  }
  if (part.textKind === 'file') return `[File #${number}: ${part.filename || 'attachment.txt'}]`;
  return '';
}

/** The display lines of a stored prompt's parts, and for each image part the
 *  line that draws it: the composer's metadata line right before it, else a
 *  bare line of its own (a bare line never stands for the next image). A
 *  stored pasted or attached text shows as its chip token. */
function restoredUserParts(content, budget) {
  const texts = [];
  const images = [];
  let pendingMetadata = '';
  let storedTexts = 0;
  // Plain text the intake moved into the store (a long prompt, a bot's message).
  const offloaded = [];
  let companionText = false;
  for (const part of content) {
    // An attachment sent by reference is model-facing text; the bubble shows
    // the attachment as the chip its message records.
    if (isMediaReferencePart(part)) continue;
    const token = isAttachmentReference(part) ? storedTextToken(part, storedTexts + 1, budget) : '';
    if (token) {
      storedTexts += 1;
      texts.push(token);
      pendingMetadata = '';
      continue;
    }
    if (part?.type === 'image' || part?.type === 'input_image') {
      let line = pendingMetadata;
      if (!line) {
        line = `[Image: ${part.mimeType || part.mediaType || 'image'}]`;
        texts.push(line);
      }
      pendingMetadata = '';
      images.push({ part, line });
      continue;
    }
    const text = isAttachmentReference(part) ? referencedFeedbackText(part) : toolResultText([part]);
    if (text) {
      texts.push(text);
      if (!IMAGE_METADATA_LINE.test(text)) companionText = true;
    } else if (isAttachmentReference(part) && part?.type === 'text' && !part.textKind) {
      // Keeps its place among the parts until it is known whether to read it.
      texts.push(part);
      offloaded.push(part);
    }
    pendingMetadata = IMAGE_METADATA_LINE.test(text) ? text.trimEnd().split(/\r?\n/).pop().trim() : '';
  }
  // A prompt whose only real text was moved out restores it in place (bounded,
  // within the load's read budget); image labels and chips are not companion
  // text. Beside real text such parts stay out, as before.
  const resolved = [];
  for (const entry of texts) {
    if (typeof entry === 'string') resolved.push(entry);
    else if (!companionText) {
      const text = offloadedPromptText(entry, budget);
      if (text) resolved.push(text);
    }
  }
  return { texts: resolved, images };
}

/**
 * The user-bubble projection of one transcript load: each stored prompt's
 * parts are worked out once (its text and its image refs share them, and a
 * load that widens its range sees the same messages again), and the blob
 * reads that count paste lines share one byte budget.
 */
export function createUserTextRestore({ readBudgetBytes = PASTED_LINE_READ_BUDGET_BYTES } = {}) {
  const budget = { remaining: readBudgetBytes };
  const parts = new WeakMap();
  const partsOf = (content) => {
    let found = parts.get(content);
    if (!found) {
      found = restoredUserParts(content, budget);
      parts.set(content, found);
    }
    return found;
  };
  return {
    text(content) {
      if (!Array.isArray(content)) {
        return withVisualizeFeedbackDisplay(typeof content === 'string' ? content : toolResultText(content));
      }
      return withVisualizeFeedbackDisplay(partsOf(content).texts.join('\n'));
    },
    /** The stored original of each image the restored bubble draws, by the
     *  `[Image: …]` line that draws it. Every image keeps its slot (one
     *  without a stored original has no `ref`) so later images do not shift
     *  onto it; empty when no image has a stored original. */
    imageRefs(content) {
      if (!Array.isArray(content)) return [];
      const slots = partsOf(content).images.map(({ part, line }) =>
        isAttachmentReference(part) ? { line, ref: part.attachmentRef } : { line }
      );
      return slots.some((slot) => slot.ref) ? slots : [];
    },
  };
}

export function restoredUserText(content) {
  return createUserTextRestore().text(content);
}

export function restoredUserImageRefs(content) {
  return createUserTextRestore().imageRefs(content);
}
