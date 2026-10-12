// The phone app's connect screens as ONE full-screen layout: a centered column
// whose fixed-height logo/title/subtitle/middle block is centered above the
// actions pinned to the bottom, so every step lands at the same place. Pure DOM and
// strings (no Capacitor), so every step renders in tests and in the preview
// switch without a network.

export const PREVIEW_STATES = [
  'start-empty',
  'code',
  'code-error',
  'code-ratelimited',
  'waiting',
  'waiting-offline',
  'declined',
  'expired',
  'revoked',
  'network-error',
  'outdated',
  'scan-unavailable',
] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

/** Steps the app can be on. `camera-off` is a variant of scan-unavailable. */
export type Step = 'start' | 'code' | 'waiting' | 'waiting-offline' | 'result';
export type ResultKind = 'declined' | 'expired' | 'revoked' | 'network-error' | 'outdated' | 'scan-unavailable' | 'camera-off';

export const STRINGS = {
  en: {
    heading: 'Connect to PC',
    note: 'On your PC, go to Mixdog Settings > Connection > Phone.',
    scan: 'Scan QR code',
    enterCode: 'Connect with a code',
    codeHeading: 'Connect with a code',
    codeNote: 'Enter the 6-digit code shown on your PC.',
    codeLabel: '6-digit code',
    cancel: 'Cancel',
    connect: 'Connect',
    retry: 'Connect again',
    waitTitle: 'Allow it on your PC',
    waitNote: 'On {pc}, press Allow on the request.',
    waitNoteNoPc: 'Press Allow on the request shown on your PC.',
    waiting: 'Waiting…',
    connecting: 'Connecting…',
    offlineTitle: 'Waiting for your PC',
    offlineNote: 'Make sure Mixdog is running on your PC.',
    declinedTitle: 'Request declined',
    declinedSub: 'Your PC declined the request.',
    expiredTitle: 'Request expired',
    expiredSub: 'Connect again to send a new request.',
    revokedTitle: 'You were disconnected',
    revokedSub: 'Your PC disconnected this device.',
    networkTitle: 'Connection failed',
    networkSub: 'Check your internet connection.',
    outdatedTitle: 'Codes unavailable',
    outdatedSub: 'Codes are not available on this connection server yet. Use the QR code.',
    scanUnavailableTitle: 'QR scanning is not available',
    scanUnavailableSub: 'Connect with a code instead.',
    cameraOffTitle: 'Camera access is off',
    cameraOffSub: 'Allow it in Settings or connect with a code.',
    codeInvalid: 'The code is wrong or has expired.',
    codeLimited: 'Too many attempts. Try again in {s} seconds.',
    updateGet: 'Download update',
    updateLater: 'Later',
    updateAvailable: 'Mixdog {v} is available.',
    notLink: 'That is not a Mixdog QR code.',
    preparing: 'Preparing the QR scanner… try again in a moment.',
    scanFailed: 'Could not scan. Connect with a code instead.',
  },
  ko: {
    heading: 'PC에 연결',
    note: 'PC의 Mixdog에서 설정 > 연결 > 휴대폰으로 이동하세요.',
    scan: 'QR 코드 스캔',
    enterCode: '코드로 연결',
    codeHeading: '코드로 연결',
    codeNote: 'PC에 표시된 6자리 코드를 입력하세요.',
    codeLabel: '6자리 코드',
    cancel: '취소',
    connect: '연결',
    retry: '다시 연결',
    waitTitle: 'PC에서 허용하세요',
    waitNote: '{pc}에 표시된 요청에서 허용을 누르세요.',
    waitNoteNoPc: 'PC에 표시된 요청에서 허용을 누르세요.',
    waiting: '기다리는 중…',
    connecting: '연결 중…',
    offlineTitle: 'PC를 기다리는 중',
    offlineNote: 'PC에서 Mixdog이 실행 중인지 확인하세요.',
    declinedTitle: '요청이 거절되었습니다',
    declinedSub: 'PC에서 요청을 거절했습니다.',
    expiredTitle: '요청이 만료되었습니다',
    expiredSub: '다시 연결해 새 요청을 보내세요.',
    revokedTitle: '연결이 해제되었습니다',
    revokedSub: 'PC에서 이 기기의 연결을 해제했습니다.',
    networkTitle: '연결하지 못했습니다',
    networkSub: '인터넷 연결을 확인하세요.',
    outdatedTitle: '코드를 사용할 수 없습니다',
    outdatedSub: '이 연결 서버에서는 아직 코드를 쓸 수 없습니다. QR 코드를 사용하세요.',
    scanUnavailableTitle: 'QR 스캔을 사용할 수 없습니다',
    scanUnavailableSub: '코드로 연결하세요.',
    cameraOffTitle: '카메라 권한이 꺼져 있습니다',
    cameraOffSub: '설정에서 허용하거나 코드로 연결하세요.',
    codeInvalid: '코드가 올바르지 않거나 만료되었습니다.',
    codeLimited: '시도가 너무 많습니다. {s}초 뒤에 다시 시도하세요.',
    updateGet: '업데이트 다운로드',
    updateLater: '나중에',
    updateAvailable: 'Mixdog {v} 버전을 사용할 수 있습니다.',
    notLink: 'Mixdog QR 코드가 아닙니다.',
    preparing: 'QR 스캐너를 준비하는 중… 잠시 후 다시 시도하세요.',
    scanFailed: '스캔하지 못했습니다. 코드로 연결하세요.',
  },
};
export type StringKey = keyof typeof STRINGS.en;
export type Strings = typeof STRINGS.en;

export interface ScreenState {
  step: Step;
  result?: ResultKind;
  /** Inline message under the subtitle (start) or the input (code). */
  error?: string;
  update?: { version: string };
  /** The PC being waited on, when its name is known. */
  pc?: string;
  /** A code is being redeemed: the input and button wait for the answer. */
  busy?: boolean;
}

export interface Action {
  id: 'scan' | 'enter-code' | 'cancel' | 'connect' | 'retry' | 'update-get' | 'update-later';
  label: string;
  primary: boolean;
}

export interface View {
  title: string;
  sub: string;
  /** The part of `sub` shown bold (the PC name). */
  subBold?: string;
  extra: 'update' | 'code' | 'wait' | 'none';
  error: string;
  /** Buttons top to bottom: the primary first, then text buttons. */
  actions: Action[][];
}

const act = (id: Action['id'], label: string, primary: boolean): Action => ({ id, label, primary });

/** What each step shows. Title, subtitle and actions exist for every step. */
export function viewFor(state: ScreenState, s: Strings): View {
  const base = { extra: 'none', error: state.error ?? '' } as const;
  if (state.step === 'start') {
    return {
      ...base,
      title: s.heading,
      sub: s.note,
      extra: state.update ? 'update' : 'none',
      actions: state.update
        ? [[act('update-get', s.updateGet, true)], [act('update-later', s.updateLater, false)]]
        : [[act('scan', s.scan, true)], [act('enter-code', s.enterCode, false)]],
    };
  }
  if (state.step === 'code') {
    return {
      ...base,
      title: s.codeHeading,
      sub: s.codeNote,
      extra: 'code',
      actions: [[act('connect', s.connect, true)], [act('cancel', s.cancel, false)]],
    };
  }
  if (state.step === 'waiting-offline') {
    return {
      ...base,
      extra: 'wait',
      title: s.offlineTitle,
      sub: s.offlineNote,
      actions: [[act('cancel', s.cancel, false)]],
    };
  }
  if (state.step === 'waiting') {
    return {
      ...base,
      extra: 'wait',
      title: s.waitTitle,
      sub: state.pc ? s.waitNote.replace('{pc}', state.pc) : s.waitNoteNoPc,
      subBold: state.pc,
      actions: [[act('cancel', s.cancel, false)]],
    };
  }
  const retry = [[act('retry', s.retry, true)], [act('cancel', s.cancel, false)]];
  switch (state.result) {
    case 'declined':
      return { ...base, title: s.declinedTitle, sub: s.declinedSub, actions: retry };
    case 'expired':
      return { ...base, title: s.expiredTitle, sub: s.expiredSub, actions: retry };
    case 'revoked':
      return { ...base, title: s.revokedTitle, sub: s.revokedSub, actions: retry };
    case 'outdated':
      return {
        ...base,
        title: s.outdatedTitle,
        sub: s.outdatedSub,
        actions: [[act('scan', s.scan, true)], [act('cancel', s.cancel, false)]],
      };
    case 'scan-unavailable':
    case 'camera-off': {
      const camera = state.result === 'camera-off';
      return {
        ...base,
        title: camera ? s.cameraOffTitle : s.scanUnavailableTitle,
        sub: camera ? s.cameraOffSub : s.scanUnavailableSub,
        actions: [[act('enter-code', s.enterCode, true)], [act('cancel', s.cancel, false)]],
      };
    }
    default:
      return { ...base, title: s.networkTitle, sub: s.networkSub, actions: retry };
  }
}

/** A preview state as a screen state; `seconds` fills the rate-limit message. */
export function stateForPreview(name: PreviewState, s: Strings): ScreenState {
  switch (name) {
    case 'start-empty':
      return { step: 'start' };
    case 'code':
      return { step: 'code' };
    case 'code-error':
      return { step: 'code', error: s.codeInvalid };
    case 'code-ratelimited':
      return { step: 'code', error: s.codeLimited.replace('{s}', '42') };
    case 'waiting':
      return { step: 'waiting', pc: 'Home PC' };
    case 'waiting-offline':
      return { step: 'waiting-offline' };
    default:
      return { step: 'result', result: name };
  }
}

/** `?mxPairingPreview=<state>`, honored only when the debug flag is set. */
export function previewFromLocation(
  search: string,
  storage: Pick<Storage, 'getItem'> | null
): PreviewState | null {
  try {
    if (storage?.getItem('mixdog.debug.pairingPreview') !== '1') return null;
    const name = new URLSearchParams(search).get('mxPairingPreview');
    return PREVIEW_STATES.find((state) => state === name) ?? null;
  } catch {
    return null;
  }
}

export interface Hooks {
  onAction(id: Action['id']): void;
  onCodeInput(digits: string): void;
}

export interface RenderInput {
  view: View;
  state: ScreenState;
  strings: Strings;
  /** The raw code text kept across re-renders. */
  codeValue: string;
}

const el = (doc: Document, tag: string, className = '', text = ''): HTMLElement => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const formatCode = (digits: string): string => (digits.length > 3 ? `${digits.slice(0, 3)}·${digits.slice(3)}` : digits);

function actionButton(doc: Document, action: Action, disabled: boolean, hooks: Hooks, label?: string): HTMLButtonElement {
  const button = el(doc, 'button', `mxp-btn${action.primary ? '' : ' sec'}`) as HTMLButtonElement;
  button.type = 'button';
  button.dataset.action = action.id;
  button.disabled = disabled;
  button.append(doc.createTextNode(label ?? action.label));
  button.addEventListener('click', () => hooks.onAction(action.id));
  return button;
}

/** Six boxes over ONE real input: paste, backspace and one-time-code
 *  autofill all act on the input; the boxes only show its digits. */
function codeEntry(root: HTMLElement, input: RenderInput, hooks: Hooks): { otp: HTMLElement; focus: () => void } {
  const doc = root.ownerDocument;
  const otp = el(doc, 'div', 'mxp-otp');
  const boxes = Array.from({ length: 6 }, () => el(doc, 'span', 'mxp-digit'));
  const field = el(doc, 'input', 'mxp-code') as HTMLInputElement;
  field.id = 'code';
  field.type = 'text';
  field.inputMode = 'numeric';
  field.autocomplete = 'one-time-code';
  field.setAttribute('aria-label', input.strings.codeLabel);
  field.value = input.codeValue;
  field.disabled = Boolean(input.state.busy);
  const paint = (): void => {
    const digits = field.value;
    boxes.forEach((box, i) => {
      box.textContent = digits[i] ?? '';
      box.classList.toggle('on', doc.activeElement === field && i === Math.min(digits.length, 5));
    });
  };
  let last = input.codeValue.length;
  field.addEventListener('input', () => {
    const digits = field.value.replace(/\D/gu, '').slice(0, 6);
    field.value = digits;
    paint();
    hooks.onCodeInput(digits);
    const connect = root.querySelector<HTMLButtonElement>('[data-action="connect"]');
    if (connect) connect.disabled = digits.length !== 6;
    const filled = digits.length === 6 && last < 6;
    last = digits.length;
    if (filled) hooks.onAction('connect');
  });
  field.addEventListener('focus', paint);
  field.addEventListener('blur', paint);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && field.value.length === 6) hooks.onAction('connect');
  });
  otp.append(...boxes, field);
  paint();
  return {
    otp,
    focus: () => {
      field.focus();
      paint();
    },
  };
}

/** Replace `root`'s content with the layout for `input`. */
export function renderPairing(root: HTMLElement, input: RenderInput, hooks: Hooks, logoSrc = './mixdog-logo-titanium.svg'): void {
  const doc = root.ownerDocument;
  const { view } = input;
  root.textContent = '';
  root.className = `mxp-screen${view.extra === 'code' ? ' mxp-code-step' : ''}`;
  const col = el(doc, 'div', 'mxp-col');
  const main = el(doc, 'main', 'mxp-main');
  // One fixed-height block, centered above the pinned actions, so every step
  // puts the logo, title, subtitle and middle slot at the same place.
  const block = el(doc, 'div', 'mxp-block');
  const vis = el(doc, 'div', 'mxp-vis');
  const logo = el(doc, 'img', 'mxp-logo') as HTMLImageElement;
  logo.src = logoSrc;
  logo.alt = '';
  logo.draggable = false;
  vis.append(logo);
  const sub = el(doc, 'p', 'mxp-sub');
  const at = view.subBold ? view.sub.indexOf(view.subBold) : -1;
  if (at < 0) sub.textContent = view.sub;
  else {
    const name = el(doc, 'b', '', view.subBold);
    sub.append(view.sub.slice(0, at), name, view.sub.slice(at + (view.subBold?.length ?? 0)));
  }
  block.append(vis, el(doc, 'h1', 'mxp-title', view.title), sub);
  const extra = el(doc, 'div', 'mxp-extra');
  let focusCode: (() => void) | null = null;
  if (view.extra === 'code') {
    const entry = codeEntry(root, input, hooks);
    extra.append(entry.otp);
    focusCode = entry.focus;
  }
  if (view.error) {
    const error = el(doc, 'p', 'mxp-error', view.error);
    error.setAttribute('role', 'alert');
    extra.append(error);
  }
  if (view.extra === 'wait') {
    const row = el(doc, 'p', 'mxp-wait');
    row.append(el(doc, 'i', 'mxp-spinner'), doc.createTextNode(input.strings.waiting));
    extra.append(row);
  }
  if (view.extra === 'update' && input.state.update) {
    extra.append(el(doc, 'p', 'mxp-fine', input.strings.updateAvailable.replace('{v}', input.state.update.version)));
  }
  block.append(extra);
  main.append(block);
  const actions = el(doc, 'footer', 'mxp-actions');
  // One rule on every step: the primary button full width, the rest as text
  // buttons below it.
  for (const action of view.actions.flat()) {
    actions.append(actionButton(
        doc,
        action,
        action.id === 'connect' && (input.codeValue.length !== 6 || Boolean(input.state.busy)),
        hooks,
        action.id === 'connect' && input.state.busy ? input.strings.connecting : undefined
      ));
  }
  col.append(main, actions);
  root.append(col);
  focusCode?.();
}

/** Keep the code form above the on-screen keyboard: the visual viewport shrinks
 *  while the layout viewport does not, and the gap becomes the bottom inset. */
export function trackKeyboardInset(root: HTMLElement, win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => undefined;
  const update = (): void => {
    const inset = Math.max(0, Math.round(win.innerHeight - viewport.height - viewport.offsetTop));
    root.style.setProperty('--mxp-kb', `${inset}px`);
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
  };
}

