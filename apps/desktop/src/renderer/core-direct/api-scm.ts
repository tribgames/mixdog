// The source-control members of the desktop API over the renderer's own core connection (DIRECT_KEYS.scm): each call is
// the request SCM_OPERATION_ROUTES makes of the operation Node's handler ran, and its reply is shaped by SCM_REPLIES.
// The inputs are checked by the core; a failure arrives already mapped as the IPC path returned it (ctx.call).
import type { DesktopApi } from '../../shared/contract';
import { DIRECT_KEYS, type DirectKey } from '../../shared/desktop-api-split.ts';
import { SCM_OPERATION_ROUTES, SCM_REPLIES } from '../../shared/scm-operation-route.ts';
import type { DirectContext } from './context.ts';

/** The two members whose operation carries another name. */
const OPERATION_OF: Readonly<Record<string, string>> = {
  githubCliLoginCancel: 'cancelGithubCliLogin',
  gitRevert: 'gitRevertFile',
};

export function createScmApi(ctx: DirectContext): Pick<DesktopApi, DirectKey<'scm'>> {
  const run = async (operation: string, args: unknown[]): Promise<unknown> => {
    const { method, params } = SCM_OPERATION_ROUTES[operation](args);
    return SCM_REPLIES[operation](await ctx.call(method, params), { args, params, call: (m, p) => ctx.call(m, p) });
  };
  const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const member of DIRECT_KEYS.scm) {
    const operation = OPERATION_OF[member] ?? member;
    api[member] = (...args) => run(operation, args);
  }
  // The git settings changed: the core announces it to every window, after the write has been saved.
  api.setGitGlobalConfig = async (...args) => {
    const saved = await run('setGitGlobalConfig', args);
    await ctx.call('ui/settings/announce', { scope: 'git' }).catch(() => {});
    return saved;
  };
  return api as unknown as Pick<DesktopApi, DirectKey<'scm'>>;
}
