import { ArrowUp, Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from './i18n';

/** Parent of an absolute host path (either separator); null at a root. */
export function parentHostPath(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return null;
  if (cut === 0) return trimmed.length > 1 ? trimmed.slice(0, 1) : null;
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${trimmed[cut]}` : parent;
}

export function joinHostPath(base: string, name: string): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${separator}${name}`;
}

/** In-app folder chooser for remote surfaces, where the OS dialog opens on the
 *  host machine. Lists directories of the host through `listProjectDir`. */
export function HostFolderBrowser({
  startPath,
  onSelect,
  onCancel,
}: {
  startPath: string;
  onSelect(path: string): void;
  onCancel(): void;
}) {
  const [current, setCurrent] = useState(startPath);
  const [draft, setDraft] = useState(startPath);
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!current) return undefined;
    let live = true;
    const list = window.mixdogDesktop?.listProjectDir;
    if (!list) {
      setError(t('Folder browsing is unavailable.'));
      return undefined;
    }
    list(current, '').then(
      (entries) => {
        if (!live) return;
        setError('');
        setFolders(entries.filter((entry) => entry.dir).map((entry) => entry.name));
      },
      () => {
        if (!live) return;
        setFolders([]);
        setError(t('This folder cannot be opened on the host computer.'));
      }
    );
    return () => {
      live = false;
    };
  }, [current]);

  const parent = current ? parentHostPath(current) : null;
  const go = (path: string) => {
    setCurrent(path);
    setDraft(path);
  };
  return (
    <div className="host-folder-browser">
      <div className="projects-folder-row">
        <input
          aria-label={t('Folder on the host computer')}
          value={draft}
          placeholder={t('Type a folder path on the host computer')}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            go(draft.trim());
          }}
        />
        <button type="button" className="extensions-action" disabled={!parent} onClick={() => parent && go(parent)}>
          <ArrowUp size={14} aria-hidden="true" /> {t('Up')}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <ul className="host-folder-list" aria-label={t('Folders')}>
        {folders.map((name) => (
          <li key={name}>
            <button type="button" className="extensions-action" onClick={() => go(joinHostPath(current, name))}>
              <Folder size={14} aria-hidden="true" /> {name}
            </button>
          </li>
        ))}
      </ul>
      <div className="projects-folder-row">
        <button type="button" className="secondary" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button type="button" disabled={!current || Boolean(error)} onClick={() => onSelect(current)}>
          {t('Select this folder')}
        </button>
      </div>
    </div>
  );
}
