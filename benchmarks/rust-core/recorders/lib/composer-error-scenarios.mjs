// The cases of apps/desktop/src/renderer/composer-submit-error.test.mjs (b6f10295a), as functions of the modules they drive (the
// recorder passes the Node tree's, the desktop's replay the product's). `readLocale(language)` returns that language's catalog.
// Each returns what the test asserted on, plus the relay frames a phone receives for the refusals.
const KEY = '"{{name}}" is switched off.';
const GENERIC = 'This bot is switched off.';

export function composerErrorScenarios({ i18n, composerSubmitErrorText, codedErrorParams, ipcErrorEnvelope, ipcErrorFromEnvelope, roomMemberSwitchedOffError, executeRemoteFrame, SUPPORTED_UI_LANGUAGES, readLocale }) {
  // What the preload does with an IPC refusal, and what remote-shim-dispatch does with a relay frame.
  const overIpc = (error) => ipcErrorFromEnvelope(structuredClone(ipcErrorEnvelope(error)));
  async function relayFrame(error) {
    return executeRemoteFrame({ send: async () => { throw error; } }, JSON.stringify({ id: 1, method: 'send', params: [] }));
  }
  const overRelay = async (error) => {
    const frame = await relayFrame(error);
    const failure = Object.assign(new Error(frame.error), { code: frame.errorCode });
    const params = codedErrorParams(frame.errorCode, JSON.parse(JSON.stringify(frame)).errorParams);
    if (params) failure.details = params;
    return failure;
  };
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
  };
}
