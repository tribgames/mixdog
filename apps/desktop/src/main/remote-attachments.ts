// A paired device opens a message's attachment through the ordinary remote
// file preview: the host reads the attachment from the content-addressed
// store by an id THIS session's transcript names, stages it as a named file
// and answers a one-file grant scoped to that session — the same
// `accessToken` rows the editor and image previews already take. The grant
// names exactly that staged file, so it reaches no other path.
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

import type { DesktopLocalPathEntry } from '../shared/contract';
import { requiredSessionId } from './desktop-state';
import { type AttachmentHost, readSessionAttachment, stageSessionAttachment } from './session-attachments';

interface AttachmentGrants {
  rememberFileGrant(absolutePath: string, sessionId: string): string;
}

export function createRemoteAttachmentMethods(deps: {
  host: AttachmentHost;
  grants: AttachmentGrants;
  /** Where staged files go; the OS temp directory unless a test says otherwise. */
  temp?: () => string;
}): Record<string, (params: unknown[]) => unknown> {
  const temp = deps.temp ?? tmpdir;
  return {
    attachmentOpen: async ([sessionId, attachmentId]): Promise<DesktopLocalPathEntry & { mimeType: string }> => {
      const session = requiredSessionId(sessionId);
      const { meta, bytes } = await readSessionAttachment(deps.host, session, attachmentId);
      const absolutePath = await stageSessionAttachment(temp(), meta, bytes);
      return {
        absolutePath,
        name: basename(absolutePath),
        dir: false,
        size: bytes.length,
        mimeType: meta.mimeType,
        projectPath: dirname(absolutePath),
        relPath: basename(absolutePath),
        accessToken: deps.grants.rememberFileGrant(absolutePath, session),
      };
    },
  };
}
