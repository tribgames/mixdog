import { Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { DesktopApi } from '../../shared/contract';
import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES,
  FEEDBACK_REPLY_EMAIL_PATTERN,
  normalizeFeedbackAttachments,
  type DesktopFeedbackAttachment,
  type DesktopFeedbackInput,
} from '../../shared/contract-feedback';
import { t } from '../i18n';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import './feedback-dialog.css';

export const FEEDBACK_MESSAGE_MAX = 8000;
export const FEEDBACK_EMAIL_MAX = 254;

type FeedbackKind = DesktopFeedbackInput['kind'];
const FEEDBACK_KINDS: ReadonlyArray<{ value: FeedbackKind; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'other', label: 'Other' },
];

type Phase = 'idle' | 'pending' | 'error' | 'sent';

const IMAGE_TYPES: ReadonlyArray<DesktopFeedbackAttachment['mimeType']> = ['image/png', 'image/jpeg', 'image/webp'];
const MIB = 1024 * 1024;

interface AttachmentItem extends DesktopFeedbackAttachment {
  key: string;
  size: number;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Read failed.'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function FeedbackDialog({
  submit,
  onClose,
}: {
  submit: DesktopApi['submitFeedback'] | undefined;
  onClose(): void;
}) {
  const uid = useId();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [attempted, setAttempted] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const attemptRef = useRef<{ key: string; id: string } | null>(null);
  const mountedRef = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<AttachmentItem[]>([]);
  const readingRef = useRef(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [reading, setReading] = useState(false);
  const [attachError, setAttachError] = useState('');
  const pending = phase === 'pending';
  const busy = pending || reading;

  const updateAttachments = (next: AttachmentItem[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const pickFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length || pendingRef.current || readingRef.current) return;
    const current = attachmentsRef.current;
    const accepted: File[] = [];
    let total = current.reduce((sum, item) => sum + item.size, 0);
    let error = '';
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type as DesktopFeedbackAttachment['mimeType'])) {
        error = t('{{name}}: only PNG, JPEG or WebP images can be attached.', { name: file.name });
      } else if (current.length + accepted.length >= FEEDBACK_ATTACHMENT_MAX_COUNT) {
        error = t('You can attach up to {{max}} images.', { max: FEEDBACK_ATTACHMENT_MAX_COUNT });
      } else if (file.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
        error = t('{{name}}: each image must be {{max}} MB or smaller.', {
          name: file.name,
          max: FEEDBACK_ATTACHMENT_MAX_BYTES / MIB,
        });
      } else if (total + file.size > FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES) {
        error = t('Images must total {{max}} MB or less.', { max: FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES / MIB });
      } else {
        accepted.push(file);
        total += file.size;
      }
    }
    setAttachError(error);
    if (!accepted.length) return;
    readingRef.current = true;
    setReading(true);
    try {
      const read = await Promise.all(
        accepted.map(async (file): Promise<AttachmentItem> => ({
          key: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type as DesktopFeedbackAttachment['mimeType'],
          data: await readBase64(file),
          size: file.size,
        }))
      );
      if (!mountedRef.current) return;
      const next = [...attachmentsRef.current, ...read];
      normalizeFeedbackAttachments(next.map(({ name, mimeType, data }) => ({ name, mimeType, data })));
      updateAttachments(next);
    } catch {
      if (mountedRef.current) setAttachError(t('The selected images could not be read. Try different images.'));
    } finally {
      readingRef.current = false;
      if (mountedRef.current) setReading(false);
    }
  };

  const removeAttachment = (key: string) => {
    if (pendingRef.current || readingRef.current) return;
    updateAttachments(attachmentsRef.current.filter((item) => item.key !== key));
    setAttachError('');
  };

  const trimmedMessage = message.trim();
  const trimmedEmail = email.trim();
  let messageError = '';
  if (!trimmedMessage) messageError = t('Enter a message.');
  else if (trimmedMessage.length > FEEDBACK_MESSAGE_MAX) {
    messageError = t('Message must be {{max}} characters or fewer.', { max: FEEDBACK_MESSAGE_MAX });
  }
  const emailError =
    trimmedEmail && (trimmedEmail.length > FEEDBACK_EMAIL_MAX || !FEEDBACK_REPLY_EMAIL_PATTERN.test(trimmedEmail))
      ? t('Enter a valid email address or leave it blank.')
      : '';

  const close = () => {
    if (!pendingRef.current) onClose();
  };
  useMobileBack(true, close);
  // Fullscreen scrim: the native caption controls dim with it.
  useEffect(() => acquireTitleBarDim(), []);
  // Focus the message on open and give focus back to the opener on close.
  useEffect(() => {
    mountedRef.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    messageRef.current?.focus();
    return () => {
      mountedRef.current = false;
      opener?.focus();
    };
  }, []);

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (pendingRef.current || readingRef.current || !submit) return;
    setAttempted(true);
    if (messageError) {
      messageRef.current?.focus();
      return;
    }
    if (emailError) {
      emailRef.current?.focus();
      return;
    }
    const images = attachmentsRef.current.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
    const payload = {
      kind,
      message: trimmedMessage,
      ...(trimmedEmail ? { replyTo: trimmedEmail } : {}),
      ...(images.length ? { attachments: images } : {}),
    };
    // An identical payload keeps its id so a retry is deduplicated; any edit
    // starts a new feedback.
    const key = JSON.stringify(payload);
    if (attemptRef.current?.key !== key) attemptRef.current = { key, id: crypto.randomUUID() };
    const input: DesktopFeedbackInput = { id: attemptRef.current.id, ...payload };
    pendingRef.current = true;
    setPhase('pending');
    void Promise.resolve()
      .then(() => submit(input))
      .then(
        (receipt) => {
          if (receipt?.status !== 'accepted') throw new Error('Feedback was not accepted.');
          // A later submission is new feedback and gets a fresh id.
          attemptRef.current = null;
          if (mountedRef.current) setPhase('sent');
        },
        () => {
          if (mountedRef.current) setPhase('error');
        }
      )
      .catch(() => {
        if (mountedRef.current) setPhase('error');
      })
      .finally(() => {
        pendingRef.current = false;
      });
  };

  const formId = `${uid}-form`;
  const messageId = `${uid}-message`;
  const emailId = `${uid}-email`;
  const sent = phase === 'sent';
  return (
    <div
      className="settings-confirm-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="settings-confirm-dialog settings-feedback-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={sent ? `${uid}-receipt` : undefined}
        data-settings-nested-dialog
      >
        <header>
          <h3 id={`${uid}-title`}>{t('Feedback')}</h3>
          <button
            type="button"
            aria-label={t('Close feedback')}
            data-settings-nested-close
            disabled={pending}
            onClick={close}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <form id={formId} className="settings-feedback-form" noValidate onSubmit={send}>
          {!sent && (
            <>
              <fieldset className="settings-feedback-kinds" disabled={pending}>
                <legend>{t('Type')}</legend>
                {FEEDBACK_KINDS.map((item) => (
                  <label key={item.value}>
                    <input
                      type="radio"
                      name={`${uid}-kind`}
                      value={item.value}
                      checked={kind === item.value}
                      onChange={() => setKind(item.value)}
                    />
                    {t(item.label)}
                  </label>
                ))}
              </fieldset>
              <div className="settings-feedback-field">
                <label htmlFor={messageId}>{t('Message')}</label>
                <textarea
                  id={messageId}
                  ref={messageRef}
                  value={message}
                  disabled={pending}
                  required
                  aria-invalid={attempted && messageError ? 'true' : undefined}
                  aria-describedby={attempted && messageError ? `${messageId}-error` : undefined}
                  placeholder={t('Describe what happened or what you would like to see.')}
                  onChange={(event) => setMessage(event.target.value)}
                />
                {attempted && messageError && (
                  <p id={`${messageId}-error`} className="settings-feedback-field-error" role="alert">
                    {messageError}
                  </p>
                )}
              </div>
              <div className="settings-feedback-field">
                <label htmlFor={emailId}>{t('Reply email')}</label>
                <input
                  id={emailId}
                  ref={emailRef}
                  type="email"
                  value={email}
                  disabled={pending}
                  autoComplete="email"
                  spellCheck={false}
                  aria-invalid={attempted && emailError ? 'true' : undefined}
                  aria-describedby={attempted && emailError ? `${emailId}-error` : undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {attempted && emailError && (
                  <p id={`${emailId}-error`} className="settings-feedback-field-error" role="alert">
                    {emailError}
                  </p>
                )}
              </div>
              <div className="settings-feedback-field">
                <div className="settings-feedback-field-head">
                  <span id={`${uid}-images`} className="settings-feedback-label">
                    {t('Attach images')}
                  </span>
                  <button
                    type="button"
                    className="settings-feedback-attach"
                    aria-label={reading ? t('Reading images…') : t('Add images')}
                    title={reading ? t('Reading images…') : t('Add images')}
                    disabled={busy || attachments.length >= FEEDBACK_ATTACHMENT_MAX_COUNT}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Plus aria-hidden="true" size={16} />
                  </button>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  multiple
                  accept={IMAGE_TYPES.join(',')}
                  aria-labelledby={`${uid}-images`}
                  data-feedback-file
                  onChange={(event) => void pickFiles(event.target.files)}
                />
                {attachments.length > 0 && (
                  <ul className="settings-feedback-attachments">
                    {attachments.map((item) => (
                      <li key={item.key}>
                        <img src={`data:${item.mimeType};base64,${item.data}`} alt="" />
                        <span className="settings-feedback-attachment-name" title={item.name}>
                          {item.name}
                        </span>
                        <button
                          type="button"
                          aria-label={t('Remove {{name}}', { name: item.name })}
                          disabled={busy}
                          onClick={() => removeAttachment(item.key)}
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {attachError && (
                  <p className="settings-feedback-field-error" role="alert">
                    {attachError}
                  </p>
                )}
              </div>
            </>
          )}
          <div aria-live="polite">
            {!submit && (
              <p className="settings-feedback-status" data-tone="error" role="alert">
                {t('Feedback is not available in this version of the app.')}
              </p>
            )}
            {phase === 'error' && (
              <p className="settings-feedback-status" data-tone="error" role="alert">
                {t('Feedback could not be sent. Your draft is kept; try again.')}
              </p>
            )}
            {sent && (
              <p id={`${uid}-receipt`} className="settings-feedback-status" data-tone="success" role="status">
                {t('Feedback received. Thank you!')}
              </p>
            )}
          </div>
        </form>
        <footer>
          {sent ? (
            <button type="button" className="primary" onClick={close}>
              {t('Close')}
            </button>
          ) : (
            <>
              <button type="button" disabled={pending} onClick={close}>
                {t('Cancel')}
              </button>
              <button type="submit" form={formId} className="primary" disabled={busy || !submit}>
                {pending ? t('Sending…') : t('Send feedback')}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}



