import {
  Bot,
  Bug,
  ClipboardCheck,
  Compass,
  Hammer,
  HardHat,
  Wrench,
} from 'lucide-react';

// Fixed-role icons (built-in roster); custom agents get the generic Bot glyph.
// Shared between the Workflows side tab and the session-header agent chip so
// the two surfaces never drift.
export const AGENT_ICONS: Record<string, typeof Bot> = {
  explore: Compass,
  maintainer: Wrench,
  worker: Hammer,
  'heavy-worker': HardHat,
  reviewer: ClipboardCheck,
  debugger: Bug,
};
export const agentIcon = (id: string) => AGENT_ICONS[id] || Bot;
