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

/** The display lines of a stored prompt's parts, and for each image part the
 *  line that draws it: the composer's metadata line right before it, else a
 *  bare line of its own (a bare line never stands for the next image). */
function restoredUserParts(content) {
  const texts = [];
  const images = [];
  let pendingMetadata = '';
  for (const part of content) {
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
    if (text) texts.push(text);
    pendingMetadata = IMAGE_METADATA_LINE.test(text) ? text.trimEnd().split(/\r?\n/).pop().trim() : '';
  }
  return { texts, images };
}

export function restoredUserText(content) {
  if (!Array.isArray(content)) {
    return withVisualizeFeedbackDisplay(typeof content === 'string' ? content : toolResultText(content));
  }
  return withVisualizeFeedbackDisplay(restoredUserParts(content).texts.join('\n'));
}

/** The stored original of each image the restored bubble draws, by the
 *  `[Image: …]` line that draws it. Every image keeps its slot (one without a
 *  stored original has no `ref`) so later images do not shift onto it; empty
 *  when no image has a stored original. */
export function restoredUserImageRefs(content) {
  if (!Array.isArray(content)) return [];
  const slots = restoredUserParts(content).images.map(({ part, line }) =>
    isAttachmentReference(part) ? { line, ref: part.attachmentRef } : { line }
  );
  return slots.some((slot) => slot.ref) ? slots : [];
}
