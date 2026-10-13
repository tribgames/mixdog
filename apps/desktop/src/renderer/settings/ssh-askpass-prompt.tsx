import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopSshAskpass } from '../../shared/contract-ssh';
import { t } from '../i18n';
import type { CapabilityApi } from './capability-data';
import { ConnDialog } from './connection-dialogs';

type Question = DesktopSshAskpass & { kind: 'passphrase' | 'password' | 'otp' | 'other' };

/** The questions ssh asks while a connection runs (passphrase, password, code).
 *  Shows the newest question that belongs to this window's attempt or cleanup. */
export function useSshAskpass(
  api: CapabilityApi,
  belongs: (attemptId: string) => boolean
): { question: DesktopSshAskpass | null; answer(secret: string | null): void } {
  const [question, setQuestion] = useState<DesktopSshAskpass | null>(null);
  const current = useRef<DesktopSshAskpass | null>(null);
  const belongsRef = useRef(belongs);
  belongsRef.current = belongs;
  useEffect(() => {
    const unsubscribe = api.subscribeSshAskpass?.((incoming) => {
      if (!belongsRef.current(incoming.attemptId)) return;
      if (incoming.kind === 'close') {
        if (current.current?.requestId !== incoming.requestId) return;
        current.current = null;
        setQuestion(null);
        return;
      }
      current.current = incoming;
      setQuestion(incoming);
    });
    return unsubscribe;
  }, [api]);
  const answer = useCallback(
    (secret: string | null) => {
      const asked = current.current;
      if (!asked) return;
      current.current = null;
      setQuestion(null);
      void api.sshAskpassReply?.(asked.attemptId, asked.requestId, secret)?.catch(() => undefined);
    },
    [api]
  );
  return { question, answer };
}

function titleFor(kind: Question['kind']): string {
  if (kind === 'passphrase') return t('Key passphrase');
  if (kind === 'password') return t('Server password');
  if (kind === 'other') return t('Server request');
  return t('Verification code');
}

/** Asks for one secret in the connect dialog's frame. It is kept in memory for
 *  this connection only and never stored. Cancelling answers ssh with nothing. */
export function SshAskpassPrompt({
  question,
  name,
  onAnswer,
}: {
  question: Question;
  name: string;
  onAnswer(secret: string | null): void;
}) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onAnswer(value);
  };
  useEffect(() => {
    // The question expires in main with the same clock; the dialog follows it.
    const timer = window.setTimeout(() => onAnswer(null), question.timeoutMs);
    return () => window.clearTimeout(timer);
  }, [question, onAnswer]);
  return (
    <ConnDialog
      title={titleFor(question.kind)}
      description={t('{{name}} asks for it to sign in.', { name })}
      viewKey={`askpass-${question.requestId}`}
      role="alertdialog"
      scrimCloses={false}
      onEscape={() => onAnswer(null)}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={() => onAnswer(null)}>
            {t('Cancel')}
          </button>
          <button type="submit" form="ssh-askpass-form" className="conn-btn conn-btn--primary">
            {t('Continue')}
          </button>
        </>
      }
    >
      <form id="ssh-askpass-form" className="conn-field" onSubmit={submit}>
        {(question.kind === 'otp' || question.kind === 'other') && question.host && (
          <p className="conn-note">{t('Request from {{host}}:', { host: question.host })}</p>
        )}
        <p className="conn-note conn-note--raw">{question.prompt.trim()}</p>
        <input
          type={question.kind === 'otp' ? 'text' : 'password'}
          className="conn-input"
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          aria-label={titleFor(question.kind)}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <div
          className={`conn-field-msg${question.retry ? ' conn-field-msg--error' : ''}`}
          role={question.retry ? 'alert' : undefined}
        >
          {question.retry
            ? t('The server did not accept it. Enter it again.')
            : t('It is used for this connection only and is not saved.')}
        </div>
      </form>
    </ConnDialog>
  );
}
