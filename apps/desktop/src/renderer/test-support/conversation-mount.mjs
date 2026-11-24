import React, { act } from 'react';
import { installPhonePaneDom } from './phone-pane-dom.mjs';
import { installTestDom } from './test-dom.mjs';

const MODEL = {
  provider: 'openai',
  model: 'gpt-conversation-mount',
  display: 'Conversation mount model',
  effortOptions: [{ value: 'high', label: 'High' }],
  fastCapable: false,
  fastEfforts: [],
  fastPreferred: false,
  modelParameterOptions: [],
  parameterVariants: [],
  defaultModelParameters: {},
  savedModelParameters: {},
};
const ROUTE = { provider: MODEL.provider, model: MODEL.model, effort: 'high' };

export const textOf = (content) =>
  typeof content === 'string'
    ? content
    : content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

/**
 * Mounts `Conversation` as a pane renders it. A pane pointed at another session keeps showing the outgoing one
 * (`shown`) until the picked one's lane lands: `show({ shown, selected })` renders the outgoing lane as the snapshot and
 * the picked session as `selectedSessionId`; landing is the render that shows the picked session itself.
 *
 * `rows`: a laid-out pane whose transcript paints its rows; animation frames then run on `frame()`.
 * `capability(request)`: the host's answer to a capability, or undefined for the default one.
 * `onCommit()`: called on every commit of the pane (a Profiler around it).
 */
export async function mountConversation(t, { rows = false, capability, onCommit } = {}) {
  const laidOut = rows ? await installPhonePaneDom(t, { mobile: false }) : null;
  const { window, document, root } = laidOut
    ? { window: laidOut.dom.window, document: laidOut.dom.window.document, root: laidOut.root }
    : installTestDom(t, {
        rootId: 'root',
        expose: [
          'navigator',
          'Element',
          'HTMLElement',
          'Node',
          'Event',
          'CustomEvent',
          'KeyboardEvent',
          'FocusEvent',
          'MutationObserver',
          'localStorage',
        ],
      });
  const frame = () =>
    act(async () => {
      for (const [id, callback] of [...(laidOut?.frames ?? [])]) {
        laidOut.frames.delete(id);
        callback(performance.now());
      }
    });
  if (laidOut) await (await import('../markdown-body-loader.ts')).preloadMarkdownBody();
  const noop = () => {};
  const capabilities = [];
  const aborts = [];
  const answers = [];
  const toasts = [];
  const sessionSubmits = [];
  window.mixdogDesktop = {
    submitToSession: async (sessionId, content, options) => {
      sessionSubmits.push({ to: sessionId, text: textOf(content), options });
      return true;
    },
    rendererDiagnostic: noop,
    listProviderModels: async () => [MODEL],
    sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
    abortSession: async (sessionId, options) => {
      aborts.push({ sessionId, options });
      return { aborted: true, restoreText: `prompt stopped in ${sessionId}` };
    },
    resolveToolApprovalForSession: async (sessionId, id, decision) => {
      answers.push({ sessionId, id, decision });
      return true;
    },
    invokeCapability: async (request) => {
      capabilities.push(request);
      const answered = capability?.(request);
      if (answered !== undefined) return { value: answered };
      if (request.capability === 'getProviderSetup') {
        return { value: { api: [{ id: MODEL.provider, authenticated: true }] } };
      }
      if (request.capability === 'rewindToItem') return { value: { text: `rewound ${request.sessionId}` } };
      if (request.capability === 'restoreQueued') {
        return { value: { count: 1, text: `queued for ${request.sessionId}` } };
      }
      return { value: null };
    },
  };
  window.addEventListener('mixdog:desktop-toast', (event) => toasts.push(event.detail));
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
  window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
  if (!globalThis.getComputedStyle) {
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    t.after(() => delete globalThis.getComputedStyle);
  }
  window.HTMLElement.prototype.scrollIntoView ??= noop;
  window.HTMLElement.prototype.attachEvent ??= noop;
  window.HTMLElement.prototype.detachEvent ??= noop;
  const { Conversation } = await import('../Conversation.tsx');
  const submits = [];
  const host = { submit: async () => true };
  /** `shown`: the session the pane still presents; `selected`: the one it was pointed at; `lane`: the shown lane. */
  const pane = ({ shown, selected, lane = {}, unavailable = false }) => {
    const snapshot = {
      sessionId: shown,
      items: [{ kind: 'user', id: `u-${shown}`, text: `question ${shown}` }],
      queued: [],
      ...ROUTE,
      ...lane,
    };
    const conversation = React.createElement(Conversation, {
      snapshot,
      routeSnapshot: snapshot,
      sessionAddress: shown,
      selectedSessionId: selected,
      selectedUnavailable: unavailable,
      invokeResult: async (action) => action(),
      errors: [],
      // The pane's host submit addresses the session the pane was pointed at.
      submit: (content, options) => {
        submits.push({ to: selected, text: textOf(content), options });
        return host.submit(content, options);
      },
      applySnapshot: noop,
      transitioning: false,
      composerFocusRequest: 0,
      onNewTask: noop,
      onClearProject: noop,
      onResumeSession: noop,
      onOpenSessions: noop,
      onOpenProjects: noop,
      onOpenSettings: noop,
      onOpenCommandSurface: noop,
      projects: [],
      showProjectSelector: false,
      activeProjectPath: 'C:/work/app',
      activeProjectLabel: 'app',
      onSelectProject: noop,
      reviewActive: true,
    });
    return onCommit ? React.createElement(React.Profiler, { id: 'pane', onRender: onCommit }, conversation) : conversation;
  };
  const show = (selection) => act(async () => root.render(pane(selection)));
  /** Closes the pane; `show` opens it again. */
  const close = () => act(async () => root.render(null));
  const input = () => document.querySelector('form.composer textarea');
  const type = (text) =>
    act(async () => {
      input().focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), text);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const press = () =>
    act(async () => {
      document
        .querySelector('form.composer')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const key = (name) =>
    act(async () => {
      input().dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  const click = (element) =>
    act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  const button = (text) => [...document.querySelectorAll('button')].find((entry) => entry.textContent.includes(text));
  const ran = (name, sessionId) =>
    capabilities.filter((request) => request.capability === name && request.sessionId === sessionId);
  return {
    window,
    document,
    host,
    show,
    close,
    frame,
    input,
    type,
    press,
    key,
    click,
    button,
    ran,
    submits,
    sessionSubmits,
    aborts,
    answers,
    toasts,
  };
}
