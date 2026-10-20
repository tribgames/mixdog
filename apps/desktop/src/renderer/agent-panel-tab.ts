// The agent panel of a home thread (the right dock's 'routines' view): two
// tabs, 프로필 · 루틴. The tab is ONE remembered choice for every home thread,
// so the dock toggle reopens the last-used one; the agent's name in its tab
// strip, or "프로필 보기", asks for the panel on 프로필.
import { useSyncExternalStore } from 'react';

export type AgentPanelTab = 'profile' | 'routines';

const AGENT_PANEL_TAB_KEY = 'mixdog.desktop.agent-panel-tab.v1';
/** Window event: open the agent panel of `detail.sessionId` (a home thread). */
export const OPEN_AGENT_PANEL_EVENT = 'mixdog:open-agent-panel';

const listeners = new Set<() => void>();
let current: AgentPanelTab = readStoredTab();

function readStoredTab(): AgentPanelTab {
  try {
    return window.localStorage.getItem(AGENT_PANEL_TAB_KEY) === 'routines' ? 'routines' : 'profile';
  } catch {
    return 'profile';
  }
}

export function agentPanelTab(): AgentPanelTab {
  return current;
}

export function setAgentPanelTab(tab: AgentPanelTab): void {
  if (tab === current) return;
  current = tab;
  try {
    window.localStorage.setItem(AGENT_PANEL_TAB_KEY, tab);
  } catch {
    // The choice degrades to this window's lifetime.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentPanelTab(): AgentPanelTab {
  return useSyncExternalStore(subscribe, agentPanelTab, agentPanelTab);
}

/** Show `sessionId`'s agent panel on 프로필 (the pane surfaces listen). */
export function openAgentProfile(sessionId: string): void {
  if (!sessionId) return;
  setAgentPanelTab('profile');
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_PANEL_EVENT, { detail: { sessionId } }));
}
