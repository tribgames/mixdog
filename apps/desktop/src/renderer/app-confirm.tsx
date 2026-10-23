// The themed replacement for window.confirm: the settings confirm dialog
// (the one "Close the getting started guide?" uses) behind a promise. It
// mounts its own root on document.body, so any handler, desktop or phone, can
// `await confirmAction(message)` without hosting dialog state. React and the
// dialog load on first use, so importing this module (every call site does)
// costs nothing, and a test can install its DOM before React starts.

export interface ConfirmActionOptions {
  /** Defaults to the message's first line (or its first question). */
  title?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
  confirmLabel?: string;
  /** The operation's identity (e.g. `discard-all:<repo>`). While a request
   *  with this key is pending, another call with the same key does not open or
   *  queue a dialog: it resolves false at once, so only the first caller's
   *  action ever runs (a double click never executes twice). Requests without
   *  a key are independent, even with identical text. */
  key?: string;
  /** A name prompt (promptAction): the text field and where its text goes. */
  input?: { value: string; label: string; maxLength?: number };
  onValue?(value: string): void;
}

/** A window.confirm-style message as dialog text: the first line, or the
 *  first question of a one-line message, is the title; the rest the body. */
export function splitConfirmMessage(message: string): { title: string; description: string } {
  const lines = message.trim();
  const newline = lines.indexOf('\n');
  if (newline > 0) return { title: lines.slice(0, newline).trim(), description: lines.slice(newline + 1).trim() };
  const question = /^(.+?[?？])\s+(\S[\s\S]*)$/.exec(lines);
  return question ? { title: question[1], description: question[2] } : { title: lines, description: '' };
}

type ConfirmDriver = (message: string, options: ConfirmActionOptions) => boolean | Promise<boolean>;
let driver: ConfirmDriver | null = null;

/** Tests answer confirmations without clicking; null restores the dialog. */
export function overrideConfirmAction(next: ConfirmDriver | null): void {
  driver = next;
}

/** Ask `message` in the themed dialog; resolves true on confirm, false on
 *  cancel, Escape, the scrim or the phone back gesture. */
export function confirmAction(message: string, options: ConfirmActionOptions = {}): Promise<boolean> {
  return present(message, options, true);
}

type PromptDriver = (title: string, options: PromptActionOptions) => string | null | Promise<string | null>;
let promptDriver: PromptDriver | null = null;

/** Tests answer prompts without typing; null restores the dialog. */
export function overridePromptAction(next: PromptDriver | null): void {
  promptDriver = next;
}

export interface PromptActionOptions {
  value: string;
  label: string;
  maxLength?: number;
  confirmLabel?: string;
  key?: string;
}

/** Ask for one line of text in the themed dialog (a window.prompt
 *  replacement): resolves the typed text on Enter / confirm, null on cancel,
 *  Escape, the scrim or the phone back gesture. */
export async function promptAction(title: string, options: PromptActionOptions): Promise<string | null> {
  if (promptDriver) return promptDriver(title, options);
  let typed = '';
  const approved = await present(
    title,
    {
      title,
      confirmLabel: options.confirmLabel,
      key: options.key,
      input: { value: options.value, label: options.label, maxLength: options.maxLength },
      onValue: (value) => {
        typed = value;
      },
    },
    true
  );
  return approved ? typed : null;
}

/** The window.alert replacement: `message` with one Close button. */
export async function alertAction(message: string): Promise<void> {
  await present(message, {}, false);
}

interface PendingConfirm {
  id: number;
  key: string | undefined;
  message: string;
  options: ConfirmActionOptions;
  asks: boolean;
  promise: Promise<boolean>;
  resolve(approved: boolean): void;
}

// One dialog host: the first request shows, the rest wait their turn. Only an
// explicit `key` dedupes (see ConfirmActionOptions.key).
const queue: PendingConfirm[] = [];
let host: { element: HTMLDivElement; root: { render(node: unknown): void; unmount(): void } } | null = null;
let starting = false;
let nextId = 0;
let opener: Element | null = null;

const DUPLICATE: Promise<boolean> = Promise.resolve(false);

function present(message: string, options: ConfirmActionOptions, asks: boolean): Promise<boolean> {
  if (driver) return Promise.resolve(driver(message, options));
  const key = options.key;
  if (key !== undefined && queue.some((entry) => entry.key === key)) return DUPLICATE;
  let resolve: (approved: boolean) => void = () => {};
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  queue.push({ id: nextId++, key, message, options, asks, promise, resolve });
  if (queue.length === 1) {
    opener = document.activeElement;
    void show();
  }
  return promise;
}

async function show(): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    const [{ createRoot }, { SettingsConfirmDialog }] = await Promise.all([
      import('react-dom/client'),
      import('./settings/capability-controls'),
    ]);
    const element = document.createElement('div');
    document.body.append(element);
    host = { element, root: createRoot(element) };
    const render = () => {
      const current = queue[0];
      if (!current) {
        host?.root.unmount();
        host?.element.remove();
        host = null;
        return;
      }
      const text = splitConfirmMessage(current.message);
      const { options } = current;
      let answered = false;
      const answer = (approved: boolean) => {
        if (answered) return;
        answered = true;
        queue.shift();
        current.resolve(approved);
        render();
      };
      host?.root.render(
        <SettingsConfirmDialog
          key={current.id}
          returnFocus={opener}
          options={{
            title: options.title ?? text.title,
            description: options.input ? '' : options.title ? current.message : text.description,
            confirmLabel: options.confirmLabel,
            danger: options.danger,
            input: options.input,
            onConfirm: current.asks
              ? (value) => {
                  if (value !== undefined) options.onValue?.(value);
                  answer(true);
                }
              : undefined,
          }}
          // The dialog closes before it confirms; let a confirm land first.
          onClose={() => queueMicrotask(() => answer(false))}
        />
      );
    };
    render();
  } finally {
    starting = false;
  }
}
