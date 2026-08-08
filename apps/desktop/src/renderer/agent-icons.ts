import {
  Bot,
  ClipboardCheck,
  Compass,
  Hammer,
  HardHat,
  Wrench,
} from 'lucide-react';

// Known service/starter icons; user-authored agents get the generic Bot glyph.
// Shared between the Workflows side tab and the session-header agent chip so
// the two surfaces never drift.
export const AGENT_ICONS: Record<string, typeof Bot> = {
  explore: Compass,
  maintainer: Wrench,
  worker: Hammer,
  'heavy-worker': HardHat,
  reviewer: ClipboardCheck,
};
export const agentIcon = (id: string) => AGENT_ICONS[id] || Bot;
