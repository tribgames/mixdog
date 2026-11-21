// A refused image send as the failed turn carries it (`errorKind.imageRefusal`, built by the core's `refusal_json`).
// Each local fix is one `imageRecovery` capability call (the `thread/imageRecovery` method).

export interface ImageRefusalBlocker {
  messageId: string;
  part: number;
  /** The picture's file name, or '' when it had none. */
  name: string;
  /** The core's sentence naming the image and the actions that work. */
  message: string;
  actions: readonly string[];
}

export interface ImageRefusal {
  blockers: readonly ImageRefusalBlocker[];
  newContextOffered: boolean;
  message: string;
}

export type ImageRecoveryRequest =
  | { type: 'state' }
  | { type: 'continueWithout'; images: { messageId: string; part: number }[] }
  | { type: 'replace'; image: { messageId: string; part: number }; data: string; name: string }
  | { type: 'undo'; images: { messageId: string; part: number }[] }
  | { type: 'newBranchWithoutContext' }
  | { type: 'undoNewBranch' }
  | { type: 'recheckHistory' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The refusal a failure's `errorKind` carries, or null for any other failure (or a malformed one: nothing is guessed). */
export function imageRefusalOf(errorKind: unknown): ImageRefusal | null {
  const refusal = isRecord(errorKind) ? errorKind.imageRefusal : undefined;
  if (!isRecord(refusal) || !Array.isArray(refusal.blockers) || refusal.blockers.length === 0) return null;
  const blockers: ImageRefusalBlocker[] = [];
  for (const blocker of refusal.blockers) {
    if (!isRecord(blocker) || typeof blocker.messageId !== 'string' || !Number.isInteger(blocker.part)) return null;
    blockers.push({
      messageId: blocker.messageId,
      part: blocker.part as number,
      name: typeof blocker.name === 'string' ? blocker.name : '',
      message: typeof blocker.message === 'string' ? blocker.message : '',
      actions: Array.isArray(blocker.actions) ? blocker.actions.filter((a): a is string => typeof a === 'string') : [],
    });
  }
  return {
    blockers,
    newContextOffered: refusal.newContextOffered === true,
    message: typeof refusal.message === 'string' ? refusal.message : '',
  };
}

const target = (blocker: ImageRefusalBlocker) => ({ messageId: blocker.messageId, part: blocker.part });

/** "Continue without these images": every blocker is named in the confirmation before this is sent. */
export function continueWithoutRequest(blockers: readonly ImageRefusalBlocker[]): ImageRecoveryRequest {
  return { type: 'continueWithout', images: blockers.map(target) };
}

export function undoRequest(blockers: readonly ImageRefusalBlocker[]): ImageRecoveryRequest {
  return { type: 'undo', images: blockers.map(target) };
}

/** "Replace image": `data` is base64 of the picture the person picked. */
export function replaceRequest(blocker: ImageRefusalBlocker, data: string, name: string): ImageRecoveryRequest {
  return { type: 'replace', image: target(blocker), data, name };
}

/** What a blocker is called to the person: its file name, else its place in the conversation. */
export function blockerLabel(blocker: ImageRefusalBlocker, ordinal: number): string {
  return blocker.name || `#${ordinal + 1}`;
}

/** An image of the history the restore check could not take, with the fixes that work for it (`part` null: none per part). */
export interface GateImage {
  messageId: string;
  part: number | null;
  message: string;
  actions: readonly string[];
}

export type ImageGate =
  | { state: 'ready' }
  | { state: 'checking'; done: number; total: number }
  | { state: 'repair'; images: readonly GateImage[] };

/** The conversation's stored image choices and restore check, as every `imageRecovery` call answers them. */
export interface ImageRecoveryState {
  edits: readonly { messageId: string; part: number; choice: string }[];
  newContextAt: string | null;
  /** The saved choices could not be read: only a new start (which replaces them) can be offered. */
  choicesUnreadable: boolean;
  gate: ImageGate;
}

function gateOf(value: unknown): ImageGate | null {
  if (!isRecord(value)) return null;
  if (value.state === 'ready') return { state: 'ready' };
  if (value.state === 'checking' && Number.isInteger(value.done) && Number.isInteger(value.total)) {
    return { state: 'checking', done: value.done as number, total: value.total as number };
  }
  if (value.state !== 'repair' || !Array.isArray(value.images)) return null;
  const images: GateImage[] = [];
  for (const image of value.images) {
    if (
      !isRecord(image) ||
      typeof image.messageId !== 'string' ||
      !(image.part === null || Number.isInteger(image.part))
    )
      return null;
    images.push({
      messageId: image.messageId,
      part: image.part as number | null,
      message: typeof image.message === 'string' ? image.message : '',
      actions: Array.isArray(image.actions) ? image.actions.filter((a): a is string => typeof a === 'string') : [],
    });
  }
  return { state: 'repair', images };
}

/** The answer of an `imageRecovery` call, or null when it is malformed (nothing is guessed). */
export function recoveryStateOf(answer: unknown): ImageRecoveryState | null {
  if (!isRecord(answer) || !Array.isArray(answer.edits)) return null;
  const gate = gateOf(answer.gate);
  if (!gate) return null;
  const edits: { messageId: string; part: number; choice: string }[] = [];
  for (const edit of answer.edits) {
    if (!isRecord(edit) || typeof edit.messageId !== 'string' || !Number.isInteger(edit.part)) return null;
    edits.push({ messageId: edit.messageId, part: edit.part as number, choice: String(edit.choice ?? '') });
  }
  return {
    edits,
    newContextAt: typeof answer.newContextAt === 'string' ? answer.newContextAt : null,
    choicesUnreadable: answer.choicesUnreadable === true,
    gate,
  };
}

/** The images among `images` the stored choices leave out or replace: what "Put the images back" undoes. */
export function chosenAmong(
  state: ImageRecoveryState,
  images: readonly { messageId: string; part: number }[]
): { messageId: string; part: number }[] {
  return images
    .filter((image) => state.edits.some((edit) => edit.messageId === image.messageId && edit.part === image.part))
    .map((image) => ({ messageId: image.messageId, part: image.part }));
}

/** The base64 payload of a data URL read from a picked file, or null when it is not a base64 data URL. */
export function base64OfDataUrl(url: string): string | null {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(url);
  return match ? match[1] : null;
}
