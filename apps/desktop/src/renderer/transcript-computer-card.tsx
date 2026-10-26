import { AppWindow, Check } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { ExtensionAction, ExtensionItemList, ExtensionItemRow } from './settings/extension-detail';
import { desktopToolComputerReadinessNotice, desktopToolComputerWindowSuccessAt } from './transcript-tool-core';

/** The window-helper notice is asked once per task: the first refused call of
 *  the turn owns it, later refusals stay quiet, and "OK" closes it for the
 *  rest of the turn. */
const MAX_REMEMBERED_TASKS = 200;
const notices = new Map<string, { owner: string; dismissed: boolean }>();
/** Per task: when a window call last worked in each tool group, so a refusal in one group turns ready for a success in a later one. */
const windowSuccesses = new Map<string, Map<string, number>>();
const listeners = new Set<() => void>();
let version = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function claim(taskKey: string, owner: string) {
  let entry = notices.get(taskKey);
  if (!entry) {
    entry = { owner, dismissed: false };
    notices.set(taskKey, entry);
    if (notices.size > MAX_REMEMBERED_TASKS) notices.delete(notices.keys().next().value as string);
  }
  return entry;
}

function noteWindowSuccess(taskKey: string, groupKey: string, at: number) {
  let groups = windowSuccesses.get(taskKey);
  if (!groups) {
    groups = new Map();
    windowSuccesses.set(taskKey, groups);
    if (windowSuccesses.size > MAX_REMEMBERED_TASKS)
      windowSuccesses.delete(windowSuccesses.keys().next().value as string);
  }
  if (groups.get(groupKey) === at) return;
  groups.set(groupKey, at);
  version += 1;
  for (const listener of listeners) listener();
}

function succeededAfter(taskKey: string, ownGroupKey: string, refusalAt: number) {
  for (const [groupKey, at] of windowSuccesses.get(taskKey) ?? []) {
    if (groupKey !== ownGroupKey && at > 0 && at >= refusalAt) return true;
  }
  return false;
}

function dismiss(taskKey: string) {
  const entry = notices.get(taskKey);
  if (!entry) return;
  entry.dismissed = true;
  version += 1;
  for (const listener of listeners) listener();
}

/** Under a group of tool calls: Linux refused a window action because the
 *  window helper is not on yet (the app installs it itself and GNOME reads it
 *  at the next login), or — once a later window call worked — that it is. */
export function ToolComputerReadinessCard({ items, taskKey }: { items: readonly TranscriptItem[]; taskKey: string }) {
  useSyncExternalStore(subscribe, () => version);
  const notice = useMemo(() => desktopToolComputerReadinessNotice(items), [items]);
  const successAt = useMemo(() => desktopToolComputerWindowSuccessAt(items), [items]);
  const groupKey = String(items[0]?.id ?? '');
  useEffect(() => {
    noteWindowSuccess(taskKey, groupKey, successAt);
  }, [taskKey, groupKey, successAt]);
  if (!notice) return null;
  const entry = claim(taskKey, notice.refusalId);
  if (entry.owner !== notice.refusalId || entry.dismissed) return null;
  const ready = notice.ready || succeededAfter(taskKey, groupKey, notice.refusalAt);
  return (
    <div className="transcript-computer-readiness" data-computer-readiness-card={ready ? 'ready' : 'relogin'}>
      <ExtensionItemList>
        {ready ? (
          <ExtensionItemRow
            icon={<Check size={16} />}
            title={t('Ready. Continuing.')}
            status={t('Computer Use')}
            tone="ok"
            description={t('The window helper is on. It will not ask again.')}
          />
        ) : (
          <ExtensionItemRow
            icon={<AppWindow size={16} />}
            title={t('Sign in again to turn on the window helper')}
            status={t('Computer Use')}
            tone="warn"
            description={t(
              'Sign out and back in to turn it on. Until then only screen viewing and mouse/keyboard are used.'
            )}
            control={<ExtensionAction onClick={() => dismiss(taskKey)}>{t('OK')}</ExtensionAction>}
          />
        )}
      </ExtensionItemList>
    </div>
  );
}
