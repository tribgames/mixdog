import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { FileLaunchConfirmation } from '../shared/local-files';
import { t } from './i18n';
import { acquireTitleBarDim } from './titlebar-dim';
import { SetiFileIcon } from './SetiFileIcon';

function FileLaunchDialog({ path, answer }: { path: string; answer(approved: boolean): void }) {
  const name = path.replace(/\\/g, '/').split('/').at(-1) || path;
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const release = acquireTitleBarDim();
    dialog.current!.showModal();
    cancel.current!.focus();
    return () => {
      release();
      prior?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="mx-dialog file-launch-dialog"
      aria-labelledby="file-launch-title"
      aria-describedby="file-launch-warning file-launch-path"
      onCancel={(event) => {
        event.preventDefault();
        answer(false);
      }}
    >
      <header>
        <h3 id="file-launch-title">{t('Run this file?')}</h3>
      </header>
      <div className="mx-dialog-body">
        <div className="file-launch-target">
          <SetiFileIcon name={name} />
          <div className="file-launch-details">
            <strong>{name}</strong>
            <p id="file-launch-path">{path}</p>
          </div>
        </div>
        <p id="file-launch-warning">{t('Only run files you trust.')}</p>
      </div>
      <footer>
        <button ref={cancel} type="button" className="secondary" onClick={() => answer(false)}>
          {t('Cancel')}
        </button>
        <button type="button" className="primary" onClick={() => answer(true)}>
          {t('Run')}
        </button>
      </footer>
    </dialog>
  );
}

export function confirmFileLaunch(path: string): Promise<boolean> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return new Promise((resolve) => {
    let answered = false;
    const answer = (approved: boolean) => {
      if (answered) return;
      answered = true;
      root.unmount();
      host.remove();
      resolve(approved);
    };
    root.render(<FileLaunchDialog path={path} answer={answer} />);
  });
}

/** Only main classifies the real target. Both chat and editor hand-offs use
 *  this flow, including selected files outside a registered Project. */
export async function openConfirmedFile<T extends string | void>(
  open: (confirmedPath?: string) => Promise<T | FileLaunchConfirmation>
): Promise<T | undefined> {
  let result = await open();
  while (result && typeof result === 'object') {
    if (!(await confirmFileLaunch(result.confirmationPath))) return undefined;
    result = await open(result.confirmationPath);
  }
  return result as T;
}
