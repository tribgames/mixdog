// The cases of apps/desktop/src/renderer/composer-submit-error.test.mjs (b6f10295a), as functions of the modules they drive (the
// recorder passes the Node tree's, the desktop's replay the product's). `readLocale(language)` returns that language's catalog.
// Each returns what the test asserted on, plus the relay frames a phone receives for the refusals.
const KEY = '"{{name}}" is switched off.';
const GENERIC = 'This bot is switched off.';

export function composerErrorScenarios({ i18n, composerSubmitErrorText, codedErrorParams, ipcErrorEnvelope, ipcErrorFromEnvelope, roomMemberSwitchedOffError, executeRemoteFrame, decodeRelayFrame, SUPPORTED_UI_LANGUAGES, readLocale }) {
  // What the preload does with an IPC refusal, and (decodeRelayFrame) what the phone page does with a relay frame.
  const overIpc = (error) => ipcErrorFromEnvelope(structuredClone(ipcErrorEnvelope(error)));
  async function relayFrame(error) {
    return executeRemoteFrame({ send: async () => { throw error; } }, JSON.stringify({ id: 1, method: 'send', params: [] }));
  }
  // The error the page rebuilds from the frame a phone received: the page's own decoder, handed the frame as its JSON text carries it.
  const overRelay = async (error) => decodeRelayFrame(JSON.parse(JSON.stringify(await relayFrame(error))));
  const view = (error) => ({ message: error.message, code: error.code ?? null, details: error.details ?? null });
  return {
    'a send to a switched-off room member shows the refusal in the UI language': async () => {
      const languages = [];
      for (const { value } of SUPPORTED_UI_LANGUAGES) {
        if (value === 'en') continue;
        const catalog = readLocale(value);
        languages.push({ value, hasString: catalog[KEY] !== undefined, hasGeneric: catalog[GENERIC] !== undefined });
        i18n.addResourceBundle(value, 'translation', catalog);
      }
      const original = roomMemberSwitchedOffError('Release');
      await i18n.changeLanguage('ko');
      try {
        const named = [original, overIpc(original), await overRelay(original)];
        const bare = Object.assign(new Error('"Release" is switched off.'), { code: 'ROOM_MEMBER_SWITCHED_OFF' });
        const unnamed = [bare, overIpc(bare), await overRelay(bare)];
        return {
          languages,
          original: view(original),
          relayFrame: await relayFrame(original),
          namedTexts: named.map(composerSubmitErrorText),
          bareRelayFrame: await relayFrame(bare),
          bareTexts: unnamed.map(composerSubmitErrorText),
          otherMessage: composerSubmitErrorText(new Error('Write a message to send.')),
          proseWithoutCode: composerSubmitErrorText(new Error('"Release" is switched off.')),
        };
      } finally {
        await i18n.changeLanguage('en');
      }
    },
    'error params are whitelisted strings, and the relay redacts them like the message': async () => {
      const code = 'ROOM_MEMBER_SWITCHED_OFF';
      const params = {
        accepted: codedErrorParams(code, { name: 'Rel', other: 'x' }) ?? null,
        refused: [null, 'x', { name: 3 }, { name: '' }, { name: 'x'.repeat(201) }, {}].map((bad) => codedErrorParams(code, bad) ?? null),
        otherCodes: ['ENOENT', 'PROJECT_UNAVAILABLE', 'WORKTREE_DIRTY', '', undefined, 'toString'].map((other) => codedErrorParams(other, { name: 'C:/secret/path.txt' }) ?? null),
      };
      const file = Object.assign(new Error('x'), { code: 'ENOENT', details: { name: 'C:/secret/path.txt' } });
      const fileFrame = await relayFrame(file);
      const error = Object.assign(new Error('x'), { code: 'ROOM_MEMBER_SWITCHED_OFF', details: { name: 'my-secret-value' } });
      const frame = await executeRemoteFrame(
        { invokeCapability: async () => { throw error; } },
        JSON.stringify({ id: 1, method: 'invokeCapability', params: [{ capability: 'saveProviderApiKey', args: { key: 'my-secret-value' } }] }),
      );
      return { params, ipcDetails: overIpc(file).details ?? null, relayDetails: (await overRelay(file)).details ?? null, fileFrame, secretFrame: frame, secretInFrame: JSON.stringify(frame).includes('my-secret-value') };
    },
    // The relay's answer to each refusal below, whole: what a phone receives. `call` is the frame the phone sent (the arguments of a
    // capability are the object the core takes as its method's params), `thrown` what the host threw.
    "the relay answers a refusal with its public params only, and redacts the call's own secrets from the message and the params": async () => {
      const refusal = (message, code, details) => Object.assign(new Error(message), code === undefined ? {} : { code }, details === undefined ? {} : { details });
      const nest = (depth, leaf) => (depth === 0 ? leaf : { [`k${depth}`]: nest(depth - 1, leaf) });
      const capability = (name, args) => ({ method: 'invokeCapability', params: [{ capability: name, args }] });
      const SWITCHED_OFF = 'ROOM_MEMBER_SWITCHED_OFF';
      const secretCall = capability('saveProviderApiKey', { providerId: 'anthropic', secret: 'my-secret-value' });
      const cases = [
        ['the secret is removed from the message', secretCall, refusal('401 for key my-secret-value', undefined)],
        ['every string of the call that is long enough is a secret', secretCall, refusal('anthropic refused my-secret-value', undefined)],
        ['the secret is removed from the params of a public code', secretCall, refusal('x', SWITCHED_OFF, { name: 'Rel-my-secret-value-x' })],
        ['the secret as a JSON body escapes it is removed too', capability('saveProviderApiKey', { providerId: 'p', secret: 'pa"ss\\word99' }), refusal('bad body {"secret":"pa\\"ss\\\\word99"} and pa"ss\\word99', undefined)],
        ['a string under six characters is no secret', capability('saveProviderApiKey', { providerId: 'p', secret: 'abc12' }), refusal('key abc12 refused', undefined)],
        ['every value of a wrapped input is a secret', capability('addConnectorAccount', { email: 'dev@example.com', appPassword: 'abcd efgh ijkl mnop' }), refusal('login failed for dev@example.com with abcd efgh ijkl mnop', undefined)],
        ['six levels down is still seen', capability('saveMcpServer', nest(6, 'deep-secret-six')), refusal('echo deep-secret-six', undefined)],
        ['seven levels down is not', capability('saveMcpServer', nest(7, 'deep-secret-seven')), refusal('echo deep-secret-seven', undefined)],
        ['arrays are walked', capability('addConnectorAccount', { keys: ['first-secret-aaa', 'second-secret-bbb'] }), refusal('first-secret-aaa then second-secret-bbb', undefined)],
        ['a pasted redirect URL is a secret', capability('completeMcpOAuthLogin', { flowId: 'flow-1', callbackUrl: 'http://localhost:1/cb?code=abcdefgh' }), refusal('bad http://localhost:1/cb?code=abcdefgh', undefined)],
        ['a handoff secret is redacted whole, however short', { method: 'provideSecretInput', params: ['req-1', 'x1'] }, refusal('pin x1 rejected x1y', undefined)],
        ['an empty handoff secret redacts nothing', { method: 'provideSecretInput', params: ['req-1', ''] }, refusal('pin  rejected', undefined)],
        ['a call that carries no secrets keeps its message', { method: 'send', params: [{ text: 'my-secret-value' }] }, refusal('my-secret-value is not a member', undefined)],
        ['a public code forwards its name', { method: 'send', params: [] }, refusal('"Release" is switched off.', SWITCHED_OFF, { name: 'Release', other: 'x' })],
        ['a name of 200 characters is forwarded', { method: 'send', params: [] }, refusal('x', SWITCHED_OFF, { name: 'n'.repeat(200) })],
        ['a name of 201 characters is not', { method: 'send', params: [] }, refusal('x', SWITCHED_OFF, { name: 'n'.repeat(201) })],
        ['an empty name is not', { method: 'send', params: [] }, refusal('x', SWITCHED_OFF, { name: '' })],
        ['a schedule code forwards its name', { method: 'send', params: [] }, refusal('x', 'SCHEDULE_NAME_TAKEN', { name: 'nightly' })],
        ['a schedule code without a public param forwards none', { method: 'send', params: [] }, refusal('x', 'SCHEDULE_RENAME_UNCERTAIN', { name: 'nightly' })],
        ['any other code forwards none', { method: 'send', params: [] }, refusal('x', 'WORKTREE_DIRTY', { files: ['C:/secret/path.txt'], name: 'C:/secret/path.txt' })],
        ['an error with no code has none', { method: 'send', params: [] }, refusal('plain', undefined)],
      ];
      const answered = [];
      for (const [why, { method, params }, thrown] of cases) {
        const frame = await executeRemoteFrame({ [method]: async () => { throw thrown; } }, JSON.stringify({ id: 1, method, params }));
        answered.push({ why, method, params, thrown: { message: thrown.message, code: thrown.code ?? null, details: thrown.details ?? null }, frame });
      }
      return { answered };
    },
  };
}
