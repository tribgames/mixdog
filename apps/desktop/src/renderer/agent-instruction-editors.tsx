// "성격과 일하는 방식": the agent's PERSONA.md (tone, how it addresses the
// user) and AGENT.md (how it works) as two labelled editors. "파일 불러오기"
// copies a local .md/.txt file's text into its editor once; nothing is linked
// or watched.
import { useId, useRef, useState } from 'react';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';

export const INSTRUCTION_FILE_MAX_BYTES = 256 * 1024;
const INSTRUCTION_FILE_ACCEPT = '.md,.txt,text/markdown,text/plain';

/** The picked file's text, or a reason it cannot be loaded. */
export async function readInstructionFile(file: File): Promise<{ text: string } | { error: string }> {
  if (!/\.(md|txt)$/i.test(file.name) || file.size > INSTRUCTION_FILE_MAX_BYTES) {
    return { error: t('Only .md or .txt files up to 256 KB can be loaded.') };
  }
  return { text: await file.text() };
}

function InstructionEditor({
  label,
  hint,
  value,
  placeholder,
  persona = false,
  disabled,
  ariaLabel,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  persona?: boolean;
  disabled: boolean;
  ariaLabel: string;
  onChange(next: string): void;
}) {
  const id = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  return (
    <div className="agent-instruction-editor" data-kind={persona ? 'persona' : 'agent'}>
      <div className="agent-instruction-head">
        <label htmlFor={id}>{label}</label>
        <code>{hint}</code>
        <button type="button" disabled={disabled} onClick={() => picker.current?.click()}>
          {t('Load file')}
        </button>
        <input
          ref={picker}
          type="file"
          hidden
          accept={INSTRUCTION_FILE_ACCEPT}
          aria-label={`${label} · ${t('Load file')}`}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file) return;
            void readInstructionFile(file).then((result) => {
              if ('error' in result) setError(result.error);
              else {
                setError('');
                onChange(result.text);
              }
            });
          }}
        />
      </div>
      <textarea
        id={id}
        className={persona ? 'agent-persona-input' : 'agent-create-instructions'}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error && <ErrorNotice error={error} />}
    </div>
  );
}

export function AgentInstructionEditors({
  persona,
  body,
  disabled,
  mixy = false,
  onPersona,
  onBody,
}: {
  persona: string;
  body: string;
  disabled: boolean;
  /** Mixy: its AGENT.md left empty means its default way of working. */
  mixy?: boolean;
  onPersona(next: string): void;
  onBody(next: string): void;
}) {
  return (
    <div className="agent-instruction-editors">
      <InstructionEditor
        persona
        label={t('Personality')}
        hint="PERSONA.md"
        ariaLabel="PERSONA.md"
        value={persona}
        placeholder={t('Describe its tone, how it addresses you, and its personality')}
        disabled={disabled}
        onChange={onPersona}
      />
      <InstructionEditor
        label={t('How it works')}
        hint="AGENT.md"
        ariaLabel="AGENT.md"
        value={body}
        placeholder={
          mixy
            ? t('Write how the representative bot works. Left empty, it works the default way.')
            : t(
                'Write what it handles, the rules it keeps, and how it leaves results. Left empty, it is filled from the name and what it does.'
              )
        }
        disabled={disabled}
        onChange={onBody}
      />
    </div>
  );
}
