import {
  Bot,
  Clock,
  FileDiff,
  GitCompare,
  Github,
  Globe,
  IdCard,
  Layers3,
  MessageSquare,
  Network,
  Package,
  PanelsTopLeft,
  Search,
  Sparkles,
  SquareTerminal,
  Users,
  Webhook,
} from 'lucide-react';
import { t } from './i18n';
import { VisualizeIcon } from './visualize-icon';

import type { WorkbenchSideViewDescriptor, WorkbenchSideViewId } from './workbench-side-view-layout';

export function createAppSideViewDescriptors(
  onPrefetch: (id: WorkbenchSideViewId) => void
): ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor> {
  return new Map([
    ['sessions', { id: 'sessions', label: t('Sessions'), icon: MessageSquare }],
    [
      'projects',
      { id: 'projects', label: t('Projects'), icon: PanelsTopLeft, onPrefetch: () => onPrefetch('projects') },
    ],
    ['workflows', { id: 'workflows', label: t('Workflow'), icon: Layers3, onPrefetch: () => onPrefetch('workflows') }],
    [
      'extensions',
      { id: 'extensions', label: t('Extensions'), icon: Package, onPrefetch: () => onPrefetch('extensions') },
    ],
    ['skills', { id: 'skills', label: t('Skills'), icon: Sparkles, onPrefetch: () => onPrefetch('skills') }],
    ['schedules', { id: 'schedules', label: t('Schedules'), icon: Clock, onPrefetch: () => onPrefetch('schedules') }],
    ['webhooks', { id: 'webhooks', label: t('Webhooks'), icon: Webhook, onPrefetch: () => onPrefetch('webhooks') }],
    ['ports', { id: 'ports', label: t('Ports'), icon: Network }],
    [
      'browser',
      {
        id: 'browser',
        label: t('Browser Use'),
        title: t('Browser'),
        icon: Globe,
        onPrefetch: () => onPrefetch('browser'),
      },
    ],
    [
      'terminal',
      { id: 'terminal', label: t('Terminal'), icon: SquareTerminal, onPrefetch: () => onPrefetch('terminal') },
    ],
    [
      'session-diff',
      {
        id: 'session-diff',
        label: t('Changes'),
        tooltip: t('Changes'),
        icon: FileDiff,
        onPrefetch: () => onPrefetch('session-diff'),
      },
    ],
    ['visualize', { id: 'visualize', label: t('Visualize'), tooltip: t('Visualize'), icon: VisualizeIcon }],
    // A home thread's agent panel (프로필 · 루틴); the view id stays 'routines'.
    ['routines', { id: 'routines', label: t('Profile'), tooltip: t('Profile'), icon: IdCard }],
    // A group room's panel: members, limits, leave/delete.
    ['room', { id: 'room', label: t('Room info'), tooltip: t('Room info'), icon: Users }],
    ['agents', { id: 'agents', label: t('Bots'), icon: Bot, onPrefetch: () => onPrefetch('agents') }],
    ['search', { id: 'search', label: t('Search'), icon: Search, onPrefetch: () => onPrefetch('search') }],
    [
      'source-control',
      {
        id: 'source-control',
        label: t('Source Control'),
        icon: GitCompare,
        onPrefetch: () => onPrefetch('source-control'),
      },
    ],
    [
      'pull-requests',
      {
        id: 'pull-requests',
        label: t('GitHub'),
        tooltip: t('GitHub'),
        icon: Github,
        onPrefetch: () => onPrefetch('pull-requests'),
      },
    ],
  ]);
}
