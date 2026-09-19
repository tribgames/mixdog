// Memory control and recall: the current session's own rows first, then the
// memory runtime (with a forced ingest of the live session when it is empty).
import { clean, toolResponseText, isEmptyRecallText, currentSessionRecallRows } from './session-text.mjs';

function isIdentityRecallQuery(query) {
  const q = clean(query).toLowerCase().replace(/\s+/g, '');
  if (!q) return false;
  return (
    /(?:\uB0B4\uAC00|\uB098\uB294|\uB098|\uC0AC\uC6A9\uC790|\uC720\uC800|user|my|me).*(?:\uB204\uAD6C|\uB204\uAD70|\uC815\uCCB4|\uC774\uB984|name|identity)|(?:whoami|whoami\?|whoami？)|who(?:am)?i|whoami/.test(
      q
    ) ||
    /^(?:\uB098\uB204\uAD6C\uB0D0|\uB098\uB294\uB204\uAD6C\uB0D0|\uB0B4\uAC00\uB204\uAD6C\uB0D0|\uB0B4\uC774\uB984\uBB50|\uB0B4\uC774\uB984\uBB50\uC57C|whoami)$/i.test(
      q
    )
  );
}

export function createRecallResourceApi({ deps }) {
  const { getConfig, getSession, getCurrentCwd, cfgMod, getMemoryModule } = deps;

  function configuredProfileIdentityLine() {
    try {
      const config = getConfig();
      const stored = config?.profile ?? config?.agent?.profile;
      const profile = cfgMod.normalizeProfileConfig(stored);
      const title = clean(profile?.title);
      if (!title) return '';
      return `[profile] Current configured user name/identity: ${title}. This profile value is authoritative; ignore stale memory rows that say the user's identity is unknown.`;
    } catch {
      return '';
    }
  }

  async function memoryModule() {
    const memoryMod = await getMemoryModule();
    if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
    return memoryMod;
  }

  return {
    async memoryControl(args = {}) {
      const memoryMod = await memoryModule();
      return toolResponseText(await memoryMod.handleToolCall('memory', args || {}));
    },
    async recall(query, args = {}) {
      const session = getSession();
      const currentCwd = getCurrentCwd();
      const baseQuery = query || args?.query || '';
      if (isIdentityRecallQuery(baseQuery)) {
        const profileLine = configuredProfileIdentityLine();
        if (profileLine) return profileLine;
      }
      if (args?.currentSession !== false && session?.id) {
        const currentText = currentSessionRecallRows(session, baseQuery, { limit: args?.limit });
        if (!isEmptyRecallText(currentText)) return currentText;
      }
      const memoryMod = await memoryModule();
      const baseArgs = {
        ...(args || {}),
        query: baseQuery,
        cwd: args?.cwd || currentCwd,
        ...(session?.id ? { currentSessionId: session.id } : {}),
      };
      let result = '(no results)';
      if (session?.id && args?.currentSession !== false && args?.forceCycleOnEmpty !== false) {
        const messages = Array.isArray(session.messages) ? session.messages : [];
        if (messages.length > 0) {
          await memoryMod.handleToolCall('memory', {
            action: 'ingest_session',
            sessionId: session.id,
            cwd: currentCwd,
            messages,
          });
          result = toolResponseText(
            await memoryMod.handleToolCall('recall', {
              ...baseArgs,
              sessionId: session.id,
              currentSession: true,
              projectScope: baseArgs.projectScope || 'all',
              includeRaw: baseArgs.includeRaw !== false,
              includeArchived: baseArgs.includeArchived !== false,
            })
          );
        }
      }
      if (isEmptyRecallText(result)) {
        result = toolResponseText(await memoryMod.handleToolCall('recall', baseArgs));
      }
      return result;
    },
  };
}
