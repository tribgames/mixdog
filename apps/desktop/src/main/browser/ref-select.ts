/** Selection is scoped to one control. Validate the whole request before
 * changing native options; custom options stay in the control's own realm. */
import type { WebContents } from 'electron';
import { BROWSER_EDITABILITY_CHECK } from './editability';
import { createBrowserRefAccess, type BrowserRefAccessHost } from './ref-access';

interface SelectionResult {
  error?: string;
  custom?: boolean;
  pending?: boolean;
  values?: string[];
}

const SELECT_NATIVE = `function(values) {
  const el = this;
  const error = (${BROWSER_EDITABILITY_CHECK})(el);
  if (error) return { error };
  if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
  if (el.options.length > 5000) return { error: 'select has too many options; narrow the control before selecting' };
  const options = Array.from(el.options);
  const selected = new Set();
  for (const value of values) {
    const matches = options.filter(option =>
      String(option.value) === value || String(option.label || option.text) === value);
    if (!matches.length) return { error: 'no option matched the requested value: ' + value };
    if (matches.length !== 1) return { error: 'requested option is ambiguous: ' + value };
    const option = matches[0];
    if (option.disabled || option.parentElement?.disabled) {
      return { error: 'requested option is disabled: ' + value };
    }
    selected.add(option);
  }
  if (!el.multiple && selected.size !== 1) {
    return { error: 'this select accepts exactly one option' };
  }
  if (el.multiple) {
    for (const option of options) option.selected = selected.has(option);
  } else {
    el.selectedIndex = options.indexOf([...selected][0]);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const actual = Array.from(el.selectedOptions);
  if (actual.length !== selected.size || actual.some(option => !selected.has(option))) {
    return { error: 'select input was dispatched once but the selection changed; observe before continuing' };
  }
  return { values: actual.map(option => String(option.value)) };
}`;

const CUSTOM_CONTROL = `
  const el = this;
  const error = (${BROWSER_EDITABILITY_CHECK})(el);
  if (error) return { error };
  const target = el.closest('[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup]') || el;
  const ids = [...new Set(
    [target.getAttribute('aria-controls'), target.getAttribute('aria-owns')]
      .filter(Boolean).join(' ').split(/\\s+/).filter(Boolean)
  )];
  const ownList = target.matches('[role="listbox"],[role="menu"],[role="tree"]');
  if (!ids.length && !ownList) {
    return { error: 'control has no associated option list; open it and choose an explicit option ref from a fresh snapshot' };
  }
`;

const OPEN_CUSTOM = `function() {
  ${CUSTOM_CONTROL}
  if (!ownList && target.getAttribute('aria-expanded') !== 'true') {
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.click();
  }
  return {};
}`;

const PICK_CUSTOM = `function(wanted) {
  ${CUSTOM_CONTROL}
  const root = target.getRootNode();
  const lists = ownList ? [target] : [];
  for (const id of ids) {
    const list = root.getElementById?.(id);
    if (list && !lists.includes(list)) lists.push(list);
  }
  if (!lists.length) return { pending: true };
  const compact = value => String(value ?? '').slice(0, 2000).replace(/\\s+/g, ' ').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = element; current; current = current.parentElement || current.getRootNode()?.host) {
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    }
    return true;
  };
  const candidates = new Set();
  const roots = [...lists];
  let scanned = 0;
  for (let index = 0; index < roots.length; index++) {
    const walker = el.ownerDocument.createTreeWalker(roots[index], 1);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++scanned > 5000) return { error: 'associated option list is too large; choose an explicit option ref' };
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (node.matches('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],[data-value]') && visible(node)) {
        candidates.add(node);
        if (candidates.size > 500) return { error: 'associated option list has too many options; choose an explicit option ref' };
      }
    }
  }
  if (!candidates.size) return { pending: true };
  const label = node => compact(node.getAttribute('aria-label') || node.textContent);
  const matches = [...candidates].filter(node =>
    label(node) === wanted || compact(node.getAttribute('data-value')) === wanted);
  if (matches.length > 1) return { error: 'requested option is ambiguous in the associated list; choose an explicit option ref' };
  if (!matches.length) {
    return { error: 'no open option matched exactly; visible options include: '
      + [...candidates].slice(0, 8).map(node => label(node).slice(0, 40)).join(' | ') };
  }
  const hit = matches[0];
  const hitError = (${BROWSER_EDITABILITY_CHECK})(hit);
  if (hitError) return { error: hitError };
  const value = label(hit) || compact(hit.getAttribute('data-value'));
  hit.scrollIntoView({ block: 'center', behavior: 'instant' });
  hit.click();
  return { values: [value.slice(0, 120)] };
}`;

export function createBrowserRefSelection(host: BrowserRefAccessHost & {
  pause(ms: number, signal?: AbortSignal): Promise<void>;
  dropdownTimeoutMs: number;
  dropdownPollMs: number;
}) {
  const { callRef } = createBrowserRefAccess(host);
  function checked(result: SelectionResult, ref: string): SelectionResult {
    if (result?.error) {
      throw new Error(result.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : result.error);
    }
    return result;
  }

  async function selectCustomRef(
    guest: WebContents, ref: string, values: string[], signal?: AbortSignal,
  ): Promise<string[]> {
    if (values.length !== 1 || !values[0].trim()) {
      throw new Error('custom dropdowns require exactly one non-empty value');
    }
    checked(await callRef<SelectionResult>(guest, ref, OPEN_CUSTOM, [], signal), ref);
    const deadline = Date.now() + host.dropdownTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
      const result = checked(
        await callRef<SelectionResult>(guest, ref, PICK_CUSTOM, [values[0].trim()], signal), ref,
      );
      if (result.values) return result.values;
      if (!result.pending || Date.now() >= deadline) {
        throw new Error('no open option list was found for this control; take a fresh snapshot');
      }
      await host.pause(host.dropdownPollMs, signal);
    }
  }

  async function selectRef(
    guest: WebContents, ref: string, values: string[], signal?: AbortSignal,
  ): Promise<string[]> {
    if (!values.length) throw new Error('select requires at least one value');
    const result = checked(await callRef<SelectionResult>(guest, ref, SELECT_NATIVE, [values], signal), ref);
    if (result.custom) return selectCustomRef(guest, ref, values, signal);
    return result.values || [];
  }

  return { selectRef, selectCustomRef };
}
