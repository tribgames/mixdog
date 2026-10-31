import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';

import { errorMessage } from '../editor-pane-session-errors';
import { t } from '../i18n';
import { registerMobileBack } from '../mobile-back';
import { record } from '../record-utils';
import { ActionButton, Group } from './capability-controls';
import type { PanelContext } from './capability-data';

// Settings → Instruction control: the full text of each orchestration mode and
// each output-style depth level, as the shipped .md or the user's override of
// the same name (src/session-runtime/workflow-agents-api/instruction-files.mjs).
// Which mode / style is in use is still chosen where it always was.

type InstructionGroup = 'delegation' | 'outputStyle';

interface InstructionFile {
  group: InstructionGroup;
  id: string;
  label: string;
  body: string;
  defaultBody: string;
  userOverride: boolean;
  modified: boolean;
  problem?: string;
  path?: string;
  revision: string;
}

const GROUPS: ReadonlyArray<{ group: InstructionGroup; title: string; description: string; crumb: string }> = [
  {
    group: 'delegation',
    title: 'Delegation',
    description: 'How the AI splits and hands off work in each mode. Choose the mode in the composer, as before.',
    crumb: 'Delegation instructions',
  },
  {
    group: 'outputStyle',
    title: 'Output style',
    description: 'How detailed each level writes. Choose the level on the Output style page.',
    crumb: 'Output style instructions',
  },
];

// The first sentence of the text, headings and list markers skipped.
export function instructionPreview(body: string): string {
  const text = body
    .split('\n')
    .filter((line) => line.trim() && !/^#{1,6}\s/.test(line))
    .join(' ')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const end = text.search(/[.!?](\s|$)/);
  return end < 0 ? text : text.slice(0, end + 1);
}

function parseItems(value: unknown): InstructionFile[] {
  return Array.isArray(value) ? (value.filter((entry) => entry && typeof entry === 'object') as InstructionFile[]) : [];
}

export function InstructionControlPanel({ data, pending, run, confirm, notice }: PanelContext) {
  const [items, setItems] = useState<InstructionFile[]>(() => parseItems(data.instructionFiles));
  const [editing, setEditing] = useState<{ group: InstructionGroup; id: string } | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => setItems(parseItems(data.instructionFiles)), [data.instructionFiles]);

  const activeMode = String(data.orchestrationMode || '');
  const activeStyle = String(record(record(data.outputStyles).current).id || '');
  const inUse = (item: InstructionFile) => item.id === (item.group === 'delegation' ? activeMode : activeStyle);
  const current = editing ? items.find((item) => item.group === editing.group && item.id === editing.id) : undefined;

  const adopt = (next: InstructionFile | undefined) => {
    if (!next) return;
    setItems((previous) => previous.map((item) => (item.group === next.group && item.id === next.id ? next : item)));
    setDraft(next.body);
  };
  // A save or reset made against text that changed meanwhile (the phone saved
  // first) is refused by the host: reload the latest and say so, so nothing
  // newer is overwritten or deleted silently.
  const guarded = async (
    item: InstructionFile,
    capability: 'saveInstructionFile' | 'resetInstructionFile',
    args: unknown[]
  ) => {
    try {
      adopt(await run<InstructionFile>(capability, args, 'instruction-write', true, false, 'throw'));
    } catch (reason) {
      const message = errorMessage(reason);
      if (!/INSTRUCTION_FILE_CONFLICT/.test(message)) {
        notice(message, 'warn');
        return;
      }
      adopt(await run<InstructionFile>('getInstructionFile', [item.group, item.id], 'instruction-reload', false, true));
      notice(t('This text was changed elsewhere. The latest version is loaded; apply your change again.'), 'warn');
    }
  };
  const edit = (item: InstructionFile) => {
    setDraft(item.body);
    setEditing({ group: item.group, id: item.id });
  };
  const back = () => setEditing(null);
  useEffect(() => (editing ? registerMobileBack(() => setEditing(null)) : undefined), [editing]);

  if (editing && current) {
    const meta = GROUPS.find((entry) => entry.group === current.group);
    const busy = Boolean(pending);
    const unchanged = draft.trim() === current.body.trim();
    return (
      <>
        <div className="instruction-subhead">
          <button type="button" className="instruction-back" aria-label={t('Back')} onClick={back}>
            <ArrowLeft aria-hidden="true" size={16} />
          </button>
          <h2>
            {current.label} <span>· {t(meta?.crumb || '')}</span>
          </h2>
        </div>
        <div className="instruction-meta">
          {current.modified && <span className="settings-status settings-status--warning">{t('Modified')}</span>}
          {current.problem && <span className="settings-status settings-status--warning">{t('File ignored')}</span>}
          {current.path && <span className="instruction-path">{current.path}</span>}
        </div>
        {current.problem && (
          <p className="instruction-note">{t('Your file could not be used; the built-in text applies.')}</p>
        )}
        <div className="workflows-md-field instruction-editor">
          <textarea
            name="instruction-text"
            aria-label={`${current.label} · ${t(meta?.crumb || '')}`}
            value={draft}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </div>
        <div className="instruction-foot">
          <ActionButton
            disabled={busy || !current.userOverride}
            onClick={() =>
              confirm({
                title: t('Reset to default?'),
                description: t('{{item}} instructions return to the built-in text. Your edits are removed.', {
                  item: current.label,
                }),
                confirmLabel: t('Reset'),
                danger: true,
                onConfirm: () =>
                  guarded(current, 'resetInstructionFile', [current.group, current.id, current.revision]),
              })
            }
          >
            {t('Reset to default')}
          </ActionButton>
          <div className="instruction-foot-actions">
            <span className="instruction-hint">{t('Saving tells running conversations only what changed')}</span>
            <ActionButton disabled={busy} onClick={back}>
              {t('Cancel')}
            </ActionButton>
            <ActionButton
              primary
              disabled={busy || unchanged || !draft.trim()}
              onClick={() =>
                guarded(current, 'saveInstructionFile', [
                  { group: current.group, id: current.id, body: draft, expectedRevision: current.revision },
                ])
              }
            >
              {t('Save')}
            </ActionButton>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {GROUPS.map(({ group, title, description }) => (
        <Group key={group} title={t(title)} description={t(description)}>
          {items
            .filter((item) => item.group === group)
            .map((item) => (
              <div className="settings-resource" key={item.id}>
                <div>
                  <div className="settings-resource-title">
                    <b>{item.label}</b>
                    {inUse(item) && (
                      <span className="settings-status settings-status--neutral">
                        <i aria-hidden="true" />
                        {t('In use')}
                      </span>
                    )}
                    {item.modified && <span className="settings-status settings-status--warning">{t('Modified')}</span>}
                    {item.problem && (
                      <span className="settings-status settings-status--warning">{t('File ignored')}</span>
                    )}
                  </div>
                  <small className="settings-resource-meta">{instructionPreview(item.body)}</small>
                </div>
                <div className="settings-resource-control">
                  <div className="settings-resource-actions">
                    <ActionButton disabled={Boolean(pending)} onClick={() => edit(item)}>
                      {t('Edit')}
                    </ActionButton>
                  </div>
                </div>
              </div>
            ))}
        </Group>
      ))}
    </>
  );
}
