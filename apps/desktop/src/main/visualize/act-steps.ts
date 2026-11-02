/**
 * The agent `visualize` tool's `act`: an ordered, bounded list of steps run on
 * one HTML pane of a tab. Main runs the loop (timeouts, waits, the time
 * limit); each step is one script the pane's frame runs, so a step works the
 * same in the side panel's frame and in an off-screen window. Input is
 * simulated in the page (synthetic DOM events), never real OS input.
 */

export const MAX_ACT_STEPS = 25;
/** The time all steps of one `act` may take together, ms. */
export const ACT_BUDGET_MS = 15_000;
const MAX_WAIT_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_MS = 100;
const MAX_SELECTOR_CHARS = 500;
const MAX_TEXT_CHARS = 10_000;
const MAX_SCRIPT_CHARS = 20_000;
const MAX_KEY_CHARS = 40;
const MAX_SCROLL_PX = 100_000;
/** Longest JSON of one evaluate result returned; the rest is cut in the page. */
export const MAX_ACT_VALUE_CHARS = 4_000;

export type VisualizeActStep =
  | { do: 'click'; selector: string }
  | { do: 'type'; selector: string; text: string }
  | {
      do: 'key';
      /** As given ("Control+a"), for the result. */
      label: string;
      key: string;
      code: string;
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
      meta: boolean;
      selector?: string;
    }
  | { do: 'scroll'; selector?: string; x?: number; y?: number }
  | { do: 'wait'; ms: number }
  | { do: 'wait'; selector: string; timeout: number }
  | { do: 'evaluate'; script: string };

export interface ActStepOutcome {
  /** 1-based position in the list. */
  step: number;
  label: string;
  ok: boolean;
  detail?: string;
  /** evaluate: the result as JSON (`undefined` when there was none). */
  value?: string;
  error?: string;
  /** evaluate timed out: its script may still be changing the page. */
  scriptRunning?: true;
}

/** Whether a run ended on a script that may still be changing the page: no
 *  final capture is taken of it. */
export const actScriptStillRunning = (outcomes: readonly ActStepOutcome[]): boolean =>
  outcomes.some((outcome) => outcome.scriptRunning === true);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function stepText(value: unknown, name: string, max: number, trim = true): string {
  if (typeof value !== 'string' || (trim ? !value.trim() : false))
    throw new Error(`${name} must be a non-empty string`);
  const clean = trim ? value.trim() : value;
  if (clean.length > max) throw new Error(`${name} must be at most ${max} characters`);
  if (clean.includes('\0')) throw new Error(`${name} is invalid`);
  return clean;
}

function stepInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

const MODIFIERS: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
};
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  space: ' ',
  return: 'Enter',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

/** "Enter", "a", "Shift+Tab", "Control+a": modifiers joined by "+", then one
 *  character or a named key (KeyboardEvent.key names). */
function parseKeyChord(raw: string): Omit<Extract<VisualizeActStep, { do: 'key' }>, 'do' | 'selector'> {
  const match = /^((?:[A-Za-z]+\+)*)(.+)$/.exec(raw) as RegExpExecArray;
  const flags = { ctrl: false, shift: false, alt: false, meta: false };
  for (const name of match[1].split('+').filter(Boolean)) {
    const flag = MODIFIERS[name.toLowerCase()];
    if (!flag) throw new Error(`key has an unknown modifier "${name}" (use Control, Shift, Alt, Meta)`);
    flags[flag] = true;
  }
  const given = match[2];
  const key = KEY_ALIASES[given.toLowerCase()] ?? given;
  if (key.length > 1 && !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
    throw new Error(`key "${given}" is neither one character nor a key name such as Enter, Tab or ArrowDown`);
  }
  let code = key;
  if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^\d$/.test(key)) code = `Digit${key}`;
  else if (key === ' ') code = 'Space';
  else if (key.length === 1) code = '';
  return { label: raw, key, code, ...flags };
}

function parseStep(raw: unknown): VisualizeActStep {
  if (!isRecord(raw)) throw new Error('must be an object with "do"');
  const selector = (required: boolean) =>
    required || (raw.selector !== undefined && raw.selector !== null)
      ? stepText(raw.selector, 'selector', MAX_SELECTOR_CHARS)
      : undefined;
  switch (raw.do) {
    case 'click':
      return { do: 'click', selector: selector(true) as string };
    case 'type':
      if (typeof raw.text !== 'string') throw new Error('type requires text (a string; "" clears the field)');
      return {
        do: 'type',
        selector: selector(true) as string,
        text: raw.text.length ? stepText(raw.text, 'text', MAX_TEXT_CHARS, false) : '',
      };
    case 'key': {
      const target = selector(false);
      return {
        do: 'key',
        ...parseKeyChord(stepText(raw.key, 'key', MAX_KEY_CHARS)),
        ...(target ? { selector: target } : {}),
      };
    }
    case 'scroll': {
      const target = selector(false);
      const by = (name: 'x' | 'y') =>
        raw[name] === undefined || raw[name] === null
          ? undefined
          : stepInteger(raw[name], name, -MAX_SCROLL_PX, MAX_SCROLL_PX);
      const x = by('x');
      const y = by('y');
      if (!target && x === undefined && y === undefined) {
        throw new Error('scroll takes a selector (into view) and/or x/y pixels to scroll by');
      }
      return {
        do: 'scroll',
        ...(target ? { selector: target } : {}),
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
      };
    }
    case 'wait': {
      const target = selector(false);
      if (target) {
        const timeout =
          raw.timeout === undefined || raw.timeout === null
            ? DEFAULT_WAIT_TIMEOUT_MS
            : stepInteger(raw.timeout, 'timeout', 1, MAX_WAIT_MS);
        return { do: 'wait', selector: target, timeout };
      }
      if (raw.ms === undefined) throw new Error('wait takes ms (a pause) or a selector (until it appears)');
      return { do: 'wait', ms: stepInteger(raw.ms, 'ms', 1, MAX_WAIT_MS) };
    }
    case 'evaluate':
      return { do: 'evaluate', script: stepText(raw.script, 'script', MAX_SCRIPT_CHARS) };
    default:
      throw new Error('do must be click, type, key, scroll, wait or evaluate');
  }
}

/** `input.steps` of an `act`: 1-MAX_ACT_STEPS steps, each validated. */
export function parseActSteps(value: unknown): VisualizeActStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACT_STEPS) {
    throw new Error(`steps must list 1-${MAX_ACT_STEPS} steps`);
  }
  return value.map((raw, index) => {
    try {
      return parseStep(raw);
    } catch (error) {
      throw new Error(`steps[${index}]: ${(error as Error).message}`);
    }
  });
}

/** How a step is named in the result. */
export function actStepLabel(step: VisualizeActStep): string {
  if (step.do === 'key') return `key ${step.label}${step.selector ? ` on ${step.selector}` : ''}`;
  if (step.do === 'wait') return 'ms' in step ? `wait ${step.ms} ms` : `wait for ${step.selector}`;
  if (step.do === 'evaluate') return 'evaluate';
  if (step.do === 'scroll') {
    const by = step.x !== undefined || step.y !== undefined ? ` by ${step.x ?? 0},${step.y ?? 0}` : '';
    return `scroll ${step.selector ?? 'page'}${by}`;
  }
  return `${step.do} ${step.selector}`;
}

/** In a pane: one step (or a wait's look-up, `find`), answered as
 *  `{ ok, detail? , found?, error? }`. */
export function actStepScript(
  step: Exclude<VisualizeActStep, { do: 'evaluate' | 'wait' }> | { do: 'find'; selector: string }
) {
  return `(() => {
  const step = ${JSON.stringify(step)};
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  const find = (selector) => {
    let el = null;
    try { el = document.querySelector(selector); } catch { return { invalid: true, error: 'invalid CSS selector ' + JSON.stringify(selector) }; }
    return el ? { el } : { error: 'no element matches ' + JSON.stringify(selector) };
  };
  try {
    const target = step.selector ? find(step.selector) : { el: null };
    if (step.do === 'find') return target.invalid ? { ok: false, error: target.error } : { ok: true, found: Boolean(target.el && target.el.checkVisibility()) };
    if (target.error) return { ok: false, error: target.error };
    const el = target.el;
    if (step.do === 'click') {
      if (el.disabled) return { ok: false, error: name(el) + ' is disabled' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const box = el.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
      if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new PointerEvent('pointerup', pointer));
      el.dispatchEvent(new MouseEvent('mouseup', at));
      el.dispatchEvent(new MouseEvent('click', at));
      return { ok: true, detail: 'clicked ' + name(el) };
    }
    if (step.do === 'type') {
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (field && el instanceof HTMLInputElement && /^(checkbox|radio|button|submit|reset|file|image|hidden)$/.test(el.type)) {
        return { ok: false, error: name(el) + ' is a ' + el.type + ' input, not a text field (use click)' };
      }
      if (!field && !el.isContentEditable) return { ok: false, error: name(el) + ' is not a text field' };
      if (el.disabled || el.readOnly) return { ok: false, error: name(el) + ' is ' + (el.disabled ? 'disabled' : 'read-only') };
      el.focus();
      if (field) Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, step.text);
      else el.textContent = step.text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: step.text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: 'typed ' + step.text.length + ' characters into ' + name(el) };
    }
    if (step.do === 'key') {
      if (el && el !== document.activeElement && typeof el.focus === 'function') el.focus();
      const into = el || document.activeElement || document.body;
      const init = { key: step.key, code: step.code, ctrlKey: step.ctrl, shiftKey: step.shift, altKey: step.alt, metaKey: step.meta, bubbles: true, cancelable: true, composed: true };
      const proceed = into.dispatchEvent(new KeyboardEvent('keydown', init));
      into.dispatchEvent(new KeyboardEvent('keyup', init));
      let extra = '';
      // The one default action pages rely on: Enter in a form field submits it.
      if (proceed && step.key === 'Enter' && !step.ctrl && !step.shift && !step.alt && !step.meta && into instanceof HTMLInputElement && into.form) {
        into.form.requestSubmit();
        extra = ' (submitted its form)';
      }
      return { ok: true, detail: 'pressed ' + step.label + ' on ' + name(into) + extra };
    }
    if (step.do === 'scroll') {
      if (el && step.x === undefined && step.y === undefined) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        return { ok: true, detail: 'scrolled ' + name(el) + ' into view' };
      }
      (el || window).scrollBy(step.x || 0, step.y || 0);
      const box = el || document.scrollingElement || document.documentElement;
      return { ok: true, detail: 'scrolled ' + (el ? name(el) : 'the page') + ' to ' + Math.round(box.scrollLeft) + ',' + Math.round(box.scrollTop) };
    }
    return { ok: false, error: 'unknown step' };
  } catch (error) {
    return { ok: false, error: 'the step failed in the page: ' + String(error && error.message || error) };
  }
})()`;
}

/** In a pane: the agent's expression (or IIFE), its awaited value as JSON cut
 *  to MAX_ACT_VALUE_CHARS, or the error it threw. */
export function actEvaluateScript(script: string): string {
  return `(async () => {
  let value;
  try {
    value = await (${script}
    );
  } catch (error) {
    return { ok: false, error: 'the script threw: ' + String(error && error.message || error) };
  }
  let json;
  try { json = JSON.stringify(value); } catch (error) { return { ok: false, error: 'the result is not JSON-serializable: ' + String(error && error.message || error) }; }
  if (json === undefined) return { ok: true, value: 'undefined' };
  return json.length > ${MAX_ACT_VALUE_CHARS}
    ? { ok: true, value: json.slice(0, ${MAX_ACT_VALUE_CHARS}), cut: json.length }
    : { ok: true, value: json };
})()`;
}

type PageAnswer = { ok?: unknown; detail?: unknown; found?: unknown; value?: unknown; cut?: unknown; error?: unknown };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class StepFailure extends Error {}

/** An evaluate that timed out: page scripts cannot be stopped, so it may
 *  still be changing the page; the run takes no final capture after it. */
class ScriptStillRunning extends StepFailure {}

/** `work`, or `timedOut()` (a StepFailure by default) once `ms` pass. */
async function within<T>(
  work: Promise<T>,
  ms: number,
  what: string,
  timedOut: () => StepFailure = () => new StepFailure(`${what} did not finish within ${ms} ms`)
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // An abandoned page call that fails later is not an unhandled rejection.
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timedOut()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A page's answer, typed; a malformed one (the page replaced a global the
 *  script uses, or the frame went away) is a failure. */
function answerOf(raw: unknown): PageAnswer & { ok: boolean } {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') throw new StepFailure('the page gave no usable answer');
  if (!raw.ok) throw new StepFailure(typeof raw.error === 'string' ? raw.error.slice(0, 300) : 'the step failed');
  return raw as PageAnswer & { ok: boolean };
}

/** Runs `steps` in order through `exec` (runs one script in the pane and
 *  resolves with its value), stopping at the first failure; every step must
 *  end within `budgetMs` of the start. */
export async function runActSteps(
  steps: readonly VisualizeActStep[],
  exec: (script: string) => Promise<unknown>,
  options: { budgetMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<ActStepOutcome[]> {
  const { budgetMs = ACT_BUDGET_MS, sleep = defaultSleep, now = Date.now } = options;
  const end = now() + budgetMs;
  const limit = `the act time limit (${budgetMs / 1000} s for all steps)`;
  const left = () => {
    const ms = end - now();
    if (ms <= 0) throw new StepFailure(`${limit} ran out`);
    return ms;
  };
  // Every page call checks the time left before it is dispatched: once the
  // limit has run out, nothing more reaches the page.
  const run = async (step: VisualizeActStep): Promise<Pick<ActStepOutcome, 'detail' | 'value'>> => {
    if (step.do === 'evaluate') {
      const ms = left();
      const answer = answerOf(
        await within(
          exec(actEvaluateScript(step.script)),
          ms,
          'the script',
          () =>
            new ScriptStillRunning(
              `the script did not finish within ${ms} ms; it may still be changing the page (page scripts cannot be stopped), so no later step or final capture was taken`
            )
        )
      );
      const value = String(answer.value);
      return typeof answer.cut === 'number'
        ? { value, detail: `result cut to ${MAX_ACT_VALUE_CHARS} of ${answer.cut} characters` }
        : { value };
    }
    if (step.do === 'wait' && 'ms' in step) {
      const ms = left();
      if (step.ms > ms) throw new StepFailure(`waiting ${step.ms} ms would pass ${limit}; ${ms} ms are left`);
      await sleep(step.ms);
      return { detail: `waited ${step.ms} ms` };
    }
    if (step.do === 'wait') {
      const started = now();
      // The step's own deadline; every look-up also stays within the time limit.
      const deadline = started + step.timeout;
      const missing = () =>
        new StepFailure(`no visible element matches ${JSON.stringify(step.selector)} after ${now() - started} ms`);
      for (;;) {
        const total = left();
        const own = deadline - now();
        if (own <= 0) throw missing();
        const answer = answerOf(
          await within(
            exec(actStepScript({ do: 'find', selector: step.selector })),
            Math.min(own, total),
            'the look-up',
            own <= total ? missing : () => new StepFailure(`${limit} ran out`)
          )
        );
        // A match that arrives after the step's deadline is too late.
        if (now() > deadline) throw missing();
        if (answer.found === true) return { detail: `${step.selector} is shown after ${now() - started} ms` };
        await sleep(Math.min(WAIT_POLL_MS, Math.max(deadline - now(), 0)));
      }
    }
    const ms = left();
    const answer = answerOf(await within(exec(actStepScript(step)), ms, 'the step'));
    return { detail: String(answer.detail ?? '') };
  };
  const outcomes: ActStepOutcome[] = [];
  for (const [index, step] of steps.entries()) {
    const label = actStepLabel(step);
    try {
      outcomes.push({ step: index + 1, label, ok: true, ...(await run(step)) });
    } catch (error) {
      const message =
        error instanceof StepFailure ? error.message : `the page could not run it: ${(error as Error).message}`;
      outcomes.push({
        step: index + 1,
        label,
        ok: false,
        error: message,
        ...(error instanceof ScriptStillRunning ? { scriptRunning: true } : {}),
      });
      break;
    }
  }
  return outcomes;
}

/** The result lines of a run: one per step run, then where it stopped. */
export function actOutcomeLines(outcomes: readonly ActStepOutcome[], total: number): string[] {
  const lines = outcomes.map((outcome) => {
    const head = `${outcome.step}. ${outcome.label}`;
    if (!outcome.ok) return `${head} — failed: ${outcome.error}`;
    const value = outcome.value === undefined ? '' : ` → ${outcome.value}`;
    return `${head} — ok${outcome.detail ? `: ${outcome.detail}` : ''}${value}`;
  });
  const failed = outcomes.find((outcome) => !outcome.ok);
  if (failed) {
    const rest = total - failed.step;
    let skipped = '';
    if (rest === 1) skipped = `; step ${total} did not run`;
    else if (rest > 1) skipped = `; steps ${failed.step + 1}-${total} did not run`;
    lines.push(`Stopped at step ${failed.step} of ${total}${skipped}.`);
  }
  return lines;
}
