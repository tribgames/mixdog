import { ArrowLeft } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { errorMessage } from '../editor-pane-session-errors';
import { t } from '../i18n';
import { registerMobileBack } from '../mobile-back';
import { ActionButton, Group, ResourceRow } from './capability-controls';
import type { PanelContext } from './capability-data';

// The instruction editor shared by Settings → Delegation and Settings → Output
// style: the full text of an orchestration mode or an output-style depth level,
// as the shipped .md or the user's override of the same name
// (src/session-runtime/workflow-agents-api/instruction-files.mjs). Which mode /
// style is in use is still chosen where it always was.

export type InstructionGroup = 'delegation' | 'outputStyle';

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

const CRUMBS: Record<InstructionGroup, string> = {
  delegation: 'Delegation instructions',
  outputStyle: 'Output style instructions',
};

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

/** Modified / File ignored badges of a row or of the editor header. */
export function InstructionBadges({ file }: { file?: InstructionFile }) {
  return (
    <>
      {file?.modified && <span className="settings-status settings-status--warning">{t('Modified')}</span>}
      {file?.problem && <span className="settings-status settings-status--warning">{t('File ignored')}</span>}
    </>
  );
}

/** The editor sub-page for one group (`editor` replaces the page while open),
 *  plus what a list row needs: its file, its badges and an Edit action. */
export function useInstructionEditor({ data, pending, run, confirm, notice }: PanelContext, group: InstructionGroup) {
  const [items, setItems] = useState<InstructionFile[]>(() => parseItems(data.instructionFiles));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // The revision the draft was started from. A settings refresh may replace
  // the listed file with another device's save; a write still names this base
  // so the host refuses it as a conflict instead of overwriting that save.
  const [base, setBase] = useState('');
  useEffect(() => setItems(parseItems(data.instructionFiles)), [data.instructionFiles]);

  const fileFor = (id: string) => items.find((item) => item.group === group && item.id === id);
  const current = editing ? fileFor(editing) : undefined;

  const adopt = (next: InstructionFile | undefined) => {
    if (!next) return;
    setItems((previous) => previous.map((item) => (item.group === next.group && item.id === next.id ? next : item)));
    setDraft(next.body);
    setBase(next.revision);
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
    setBase(item.revision);
    setEditing(item.id);
  };
  const back = () => setEditing(null);
  useEffect(() => (editing ? registerMobileBack(() => setEditing(null)) : undefined), [editing]);

  const crumb = t(CRUMBS[group]);
  let editor: ReactNode = null;
  if (current) {
    const busy = Boolean(pending);
    const unchanged = draft.trim() === current.body.trim();
    editor = (
      <>
        <div className="instruction-subhead">
          <button type="button" className="instruction-back" aria-label={t('Back')} onClick={back}>
            <ArrowLeft aria-hidden="true" size={16} />
          </button>
          <h2>
            {current.label} <span>· {crumb}</span>
          </h2>
        </div>
        <div className="instruction-meta">
          <InstructionBadges file={current} />
          {current.path && <span className="instruction-path">{current.path}</span>}
        </div>
        {current.problem && (
          <p className="instruction-note">{t('Your file could not be used; the built-in text applies.')}</p>
        )}
        <div className="workflows-md-field instruction-editor">
          <textarea
            name="instruction-text"
            aria-label={`${current.label} · ${crumb}`}
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
                onConfirm: () => guarded(current, 'resetInstructionFile', [current.group, current.id, base]),
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
                  { group: current.group, id: current.id, body: draft, expectedRevision: base },
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

  const editButton = (id: string) => {
    const item = fileFor(id);
    return item ? (
      <ActionButton disabled={Boolean(pending)} onClick={() => edit(item)}>
        {t('Edit')}
      </ActionButton>
    ) : null;
  };
  return { items: items.filter((item) => item.group === group), fileFor, editButton, editor };
}

// Settings → Delegation: the four orchestration modes. The mode in use is
// still chosen in the composer; this page only edits each mode's text.
export function DelegationPanel(context: PanelContext) {
  const { items, fileFor, editButton, editor } = useInstructionEditor(context, 'delegation');
  if (editor) return editor;
  const activeMode = String(context.data.orchestrationMode || '');
  return (
    <Group
      title={t('Delegation mode')}
      description={t('How the AI splits and hands off work in each mode. Choose the mode in the composer, as before.')}
    >
      {items.map((item) => (
        <ResourceRow
          key={item.id}
          title={item.label}
          meta={instructionPreview(item.body)}
          status={item.id === activeMode ? 'In use' : undefined}
          badges={<InstructionBadges file={fileFor(item.id)} />}
          actions={editButton(item.id)}
        />
      ))}
    </Group>
  );
}
