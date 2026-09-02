export const CHROME_REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';

export interface ChromeUiaAncestor {
  runtime_id: string;
  role: string;
  name: string;
}

export interface ChromeUiaElement {
  ref: string;
  source: 'uia' | 'msaa' | 'ocr';
  role: string;
  name: string;
  value: string;
  state: string;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  actions: string[];
  runtime_id?: string;
  parent_runtime_id?: string;
  class_name?: string;
  has_keyboard_focus?: boolean;
  in_document?: boolean;
  ancestors?: ChromeUiaAncestor[];
}

export interface ChromeSetupControl {
  ref: string;
  enabled: boolean;
}

export interface ChromeAddressField {
  ref: string;
  value: string;
}

function normalized(value: unknown): string {
  return String(value || '').trim();
}

function isDescendantOf(element: ChromeUiaElement, runtimeId: string): boolean {
  return Boolean(runtimeId)
    && (element.ancestors || []).some((ancestor) => ancestor.runtime_id === runtimeId);
}

export function chromeNativeAddressField(
  elements: ChromeUiaElement[],
): ChromeAddressField {
  const matches = elements.filter((element) =>
    element.source === 'uia'
    && element.role === 'Edit'
    && element.enabled
    && element.in_document !== true
    && element.actions.includes('set_value'));
  if (matches.length !== 1) {
    throw new Error('Chrome did not expose one exact native editable address field.');
  }
  return { ref: matches[0].ref, value: normalized(matches[0].value) };
}

export function chromeSetupControl(
  elements: ChromeUiaElement[],
): ChromeSetupControl | null {
  const exactAddressFields = elements.filter((element) =>
    element.source === 'uia'
    && element.role === 'Edit'
    && element.in_document !== true
    && normalized(element.value).toLowerCase() === CHROME_REMOTE_DEBUGGING_URL.toLowerCase());
  if (exactAddressFields.length === 0) return null;
  if (exactAddressFields.length !== 1) {
    throw new Error('Chrome exposed multiple native address fields with the remote-debugging setup URL.');
  }
  const documents = elements.filter((element) =>
    element.source === 'uia'
    && element.role === 'Document'
    && element.runtime_id);
  if (documents.length !== 1) {
    throw new Error('Chrome did not expose one exact remote-debugging setup document.');
  }
  const checkboxes = elements.filter((element) =>
    element.source === 'uia'
    && element.role === 'CheckBox'
    && element.enabled
    && element.actions.includes('toggle')
    && element.in_document === true
    && isDescendantOf(element, documents[0].runtime_id || ''));
  if (checkboxes.length !== 1) {
    throw new Error('Chrome did not expose one exact remote-debugging setup control.');
  }
  return {
    ref: checkboxes[0].ref,
    enabled: /(?:^|;)toggle=(?:on|1|true)(?:;|$)/i.test(checkboxes[0].state),
  };
}

interface ConsentButton {
  element: ChromeUiaElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function edgeGap(first: ConsentButton, second: ConsentButton): number | null {
  if (first.top !== second.top || first.bottom !== second.bottom) return null;
  if (first.right <= second.left) return second.left - first.right;
  if (second.right <= first.left) return first.left - second.right;
  return null;
}

function selectConsentActions(candidates: ConsentButton[]): {
  allow: ConsentButton;
  cancel: ConsentButton;
} {
  if (candidates.length !== 3) {
    throw new Error('Chrome native consent did not expose exactly three distinct dialog buttons.');
  }
  const focused = candidates
    .map((candidate, index) => candidate.element.has_keyboard_focus ? index : -1)
    .filter((index) => index >= 0);
  if (focused.length > 1) {
    throw new Error('Chrome native consent exposed multiple focused dialog buttons.');
  }
  const gaps: Array<{ gap: number; first: number; second: number }> = [];
  for (let first = 0; first < candidates.length; first += 1) {
    for (let second = first + 1; second < candidates.length; second += 1) {
      const gap = edgeGap(candidates[first], candidates[second]);
      if (gap !== null) gaps.push({ gap, first, second });
    }
  }
  gaps.sort((left, right) => left.gap - right.gap);
  if (gaps.length !== 3) {
    throw new Error('Chrome native consent buttons did not form one exact dialog row.');
  }
  const standard = gaps[0];
  const extra = gaps[1];
  const firstWidth = candidates[standard.first].right - candidates[standard.first].left;
  const secondWidth = candidates[standard.second].right - candidates[standard.second].left;
  if (standard.gap >= extra.gap
    || standard.gap > Math.max(firstWidth, secondWidth)
    || extra.gap < standard.gap * 2) {
    throw new Error('Chrome native consent had no uniquely separated standard button pair.');
  }
  const extraIndex = [0, 1, 2]
    .find((index) => index !== standard.first && index !== standard.second);
  if (extraIndex === undefined) {
    throw new Error('Chrome native consent button geometry was incomplete.');
  }
  const firstToExtra = edgeGap(candidates[standard.first], candidates[extraIndex]);
  const secondToExtra = edgeGap(candidates[standard.second], candidates[extraIndex]);
  let allowIndex = -1;
  if (firstToExtra !== null && secondToExtra !== null && firstToExtra < secondToExtra) {
    allowIndex = standard.first;
  } else if (firstToExtra !== null && secondToExtra !== null && secondToExtra < firstToExtra) {
    allowIndex = standard.second;
  }
  if (allowIndex < 0) {
    throw new Error('Chrome native consent had no unique allow action adjacent to the extra action.');
  }
  const cancelIndex = allowIndex === standard.first ? standard.second : standard.first;
  if (focused.length === 1 && focused[0] !== cancelIndex) {
    throw new Error('Chrome native consent focus contradicted the structural cancel action.');
  }
  return { allow: candidates[allowIndex], cancel: candidates[cancelIndex] };
}

function trustedNative(element: ChromeUiaElement): boolean {
  return element.source === 'uia'
    && element.in_document !== true
    && element.role !== 'Document';
}

function promptSurfaces(elements: ChromeUiaElement[]): ChromeUiaElement[] {
  return elements.filter((root) => {
    if (!trustedNative(root) || !root.runtime_id || !normalized(root.name)) return false;
    const descendants = elements.filter((element) =>
      trustedNative(element)
      && isDescendantOf(element, root.runtime_id || ''));
    if (root.role === 'Window') {
      const matchingPaneAncestor = (root.ancestors || []).some((ancestor) =>
        ancestor.role === 'Pane' && normalized(ancestor.name) === normalized(root.name));
      return matchingPaneAncestor
        && descendants.some((element) =>
          element.role === 'Text' && normalized(element.name) === normalized(root.name));
    }
    if (root.role !== 'Pane') return false;
    const directTitle = descendants.some((element) =>
      element.parent_runtime_id === root.runtime_id
      && element.role === 'Text'
      && normalized(element.name) === normalized(root.name));
    const nestedTitle = descendants.some((element) =>
      element.parent_runtime_id !== root.runtime_id
      && element.role === 'Text'
      && normalized(element.name) === normalized(root.name));
    const nestedWindow = descendants.some((element) => element.role === 'Window');
    return directTitle && nestedTitle && !nestedWindow;
  });
}

function consentButtons(
  elements: ChromeUiaElement[],
  withinRuntimeId?: string,
): ConsentButton[] {
  return elements
    .filter((element) =>
      trustedNative(element)
      && (!withinRuntimeId || isDescendantOf(element, withinRuntimeId))
      && element.role === 'Button'
      && element.enabled
      && element.actions.includes('invoke')
      && element.class_name === 'MdTextButton'
      && element.width > 0
      && element.height > 0)
    .map((element) => ({
      element,
      left: element.x,
      top: element.y,
      right: element.x + element.width,
      bottom: element.y + element.height,
    }))
    .filter((candidate, index, all) =>
      all.findIndex((other) =>
        other.left === candidate.left
        && other.top === candidate.top
        && other.right === candidate.right
        && other.bottom === candidate.bottom) === index);
}

export function chromeOwnedConsentAllowRef(elements: ChromeUiaElement[]): string | null {
  const candidates = consentButtons(elements);
  if (candidates.length === 0) return null;
  return selectConsentActions(candidates).allow.element.ref;
}

export function chromeConsentAllowRef(elements: ChromeUiaElement[]): string | null {
  const surfaces = promptSurfaces(elements);
  if (surfaces.length === 0) return null;
  const matches: string[] = [];
  for (const surface of surfaces) {
    const candidates = consentButtons(elements, surface.runtime_id);
    matches.push(selectConsentActions(candidates).allow.element.ref);
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new Error('Chrome exposed multiple bound native consent prompts.');
  }
  return unique[0];
}
