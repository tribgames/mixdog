// GitHub device-flow code, shared by Settings → Git and onboarding. The code
// sits where the card's description goes and the host card's own action slot
// carries "Copy & open GitHub", so the browser never covers a code the user
// has not seen yet.
import { useState } from 'react';

import type { DesktopApi, DesktopGithubCliLoginFlow } from '../../shared/contract';
import { t } from '../i18n';
import { copyTextToClipboard } from '../text-format';
import '../desktop/github-device-code.css';

const DEVICE_URL = 'https://github.com/login/device';

type CopyState = '' | 'copied' | 'failed';

export interface GithubDeviceCodeState {
  /** A code is on screen for the live flow. */
  active: boolean;
  code: string;
  opened: boolean;
  copy: CopyState;
  /** Copy the code, then let gh open the device page (or open it here). */
  openGithub(): void;
  reopen(): void;
}

export function useGithubDeviceCode(
  host: Partial<DesktopApi> | undefined,
  flow: DesktopGithubCliLoginFlow | null,
  open: (url: string) => void
): GithubDeviceCodeState {
  const flowId = flow?.code ? flow.flowId : '';
  const fresh = { flowId, opened: false, copy: '' as CopyState };
  const [saved, setSaved] = useState(fresh);
  // A new flow (new code) starts over.
  const current = saved.flowId === flowId ? saved : fresh;
  const patch = (next: Partial<typeof fresh>) =>
    setSaved((prev) => ({ ...(prev.flowId === flowId ? prev : fresh), ...next }));
  const code = flow?.code || '';
  const url = flow?.url || DEVICE_URL;
  return {
    active: Boolean(flowId),
    code,
    opened: current.opened,
    copy: current.copy,
    openGithub: () => {
      void copyTextToClipboard(code)
        .then(
          () => patch({ copy: 'copied', opened: true }),
          () => patch({ copy: 'failed', opened: true })
        )
        .then(() => host?.githubCliLoginOpenBrowser?.(flowId).catch(() => false))
        .then((ghOpens) => {
          if (!ghOpens) open(url);
        });
    },
    reopen: () => open(url),
  };
}

export function GithubDeviceCodeText({ state, className = '' }: { state: GithubDeviceCodeState; className?: string }) {
  return (
    <div className={`github-device-code ${className}`.trim()} role="status">
      <div className="github-device-code-line">
        <code className="github-device-code-value">{state.code}</code>
        {state.copy === 'copied' && <span className="github-device-code-copied">✓ {t('Copied')}</span>}
      </div>
      {state.copy === 'failed' && (
        <span className="github-device-code-error">{t('Could not copy the code — type it on GitHub instead.')}</span>
      )}
      <span>{t('Paste the code on the GitHub page (Ctrl+V), then click Continue → Authorize.')}</span>
      {state.opened && (
        <span className="github-device-code-waiting">
          <span className="github-device-code-spinner" aria-hidden="true" />
          {t('Waiting for approval on GitHub…')}
        </span>
      )}
    </div>
  );
}
