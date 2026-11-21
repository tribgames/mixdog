/** On GNOME Wayland a client window cannot opt out of keyboard focus, so the shell extension draws the pill; it hides the pill unless refreshed. */
import { gnomeSetIndicator, type GnomeIndicatorSpec } from '../host/gnome-helper';
import type { ComputerUseOverlayPresentation } from './model';

export const INDICATOR_REFRESH_MS = 5000;

export interface GnomeIndicator {
  show(presentation: ComputerUseOverlayPresentation): Promise<void>;
  dispose(): void;
}

export interface GnomeIndicatorDeps {
  send(spec: GnomeIndicatorSpec): Promise<void>;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  warn(message: string): void;
}

const realDeps: GnomeIndicatorDeps = {
  send: (spec) => gnomeSetIndicator(spec),
  setInterval: (callback, ms) => {
    const timer = setInterval(callback, ms);
    timer.unref();
    return timer;
  },
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
  warn: (message) => console.warn(`[computer-overlay] ${message}`),
};

export function indicatorSpec(presentation: ComputerUseOverlayPresentation, locale: string): GnomeIndicatorSpec {
  if (!presentation.visible) return { visible: false };
  const stop = locale.toLowerCase().startsWith('ko') ? '중단' : 'Stop';
  return {
    visible: true,
    title: presentation.title,
    hint: `${stop} Ctrl+Alt+Esc`,
    accent: presentation.accent,
    paused: presentation.paused,
    attention: presentation.attention,
  };
}

export function createGnomeIndicator(locale: string, deps: GnomeIndicatorDeps = realDeps): GnomeIndicator {
  let sent = '';
  let refresh: unknown = null;
  let warned = false;
  let latest: GnomeIndicatorSpec = { visible: false };

  const push = async (spec: GnomeIndicatorSpec): Promise<void> => {
    try {
      await deps.send(spec);
      warned = false;
    } catch (error) {
      // The pill is the user's signal that an agent drives the desktop; say so once per failure run.
      if (!warned) deps.warn(`indicator_unavailable ${error instanceof Error ? error.message : String(error)}`);
      warned = true;
      sent = '';
    }
  };

  return {
    async show(presentation) {
      latest = indicatorSpec(presentation, locale);
      const key = JSON.stringify(latest);
      if (latest.visible && refresh === null) {
        refresh = deps.setInterval(() => void push(latest), INDICATOR_REFRESH_MS);
      } else if (!latest.visible && refresh !== null) {
        deps.clearInterval(refresh);
        refresh = null;
      }
      if (key === sent) return;
      sent = key;
      await push(latest);
    },
    dispose() {
      if (refresh !== null) deps.clearInterval(refresh);
      refresh = null;
      if (sent && latest.visible) void push({ visible: false });
      sent = '';
    },
  };
}
