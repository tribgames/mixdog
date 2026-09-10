import test from "node:test";
import assert from "node:assert/strict";
import { registerDesktopIpc } from "./ipc";
import { DESKTOP_IPC } from "../shared/contract";
import { translateNativeUi } from "../shared/native-ui";
import { SUPPORTED_UI_LANGUAGES } from "../shared/ui-language";

test("file dialogs use the selected UI language without translating filesystem contracts", async (context) => {
  const handlers = new Map();
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false, send() {} };
  const dialogs = [];
  let language = "en";
  const remove = registerDesktopIpc({ webContents, isDestroyed: () => false }, {
    subscribe: () => () => {}, subscribeSessionStates: () => () => {},
  }, {
    app: { quit() {} },
    translateUi: (key) => translateNativeUi(language, key),
    ipcMain: {
      handle: (key, handler) => handlers.set(key, handler),
      removeHandler: (key) => handlers.delete(key), on() {}, removeListener() {},
    },
    dialog: {
      showOpenDialog: async (_window, options) => { dialogs.push(options); return { canceled: true, filePaths: [] }; },
      showSaveDialog: async (_window, options) => { dialogs.push(options); return { canceled: true }; },
    },
    shell: { openPath: async () => "", openExternal: async () => {} },
  });
  context.after(remove);
  const event = { sender: webContents, senderFrame: mainFrame };
  const cases = [
    [DESKTOP_IPC.chooseProject, "Choose a Mixdog project folder", []],
    [DESKTOP_IPC.chooseFile, "Open file", []],
    [DESKTOP_IPC.chooseFiles, "Open files", []],
    [DESKTOP_IPC.chooseWorkspace, "Open Project File", []],
    [DESKTOP_IPC.saveWorkspace, "Save Project File As", ["", []]],
  ];
  for (const entry of SUPPORTED_UI_LANGUAGES) {
    language = entry.value;
    for (const [channel, title, args] of cases) {
      await handlers.get(channel)(event, ...args);
      const options = dialogs.at(-1);
      assert.equal(options.title, translateNativeUi(language, title), `${language}: ${title}`);
      if (language !== "en") assert.notEqual(options.title, title, language);
      if (options.filters) {
        assert.equal(options.filters[0].name, translateNativeUi(language, "Project file"));
        assert.deepEqual(options.filters[0].extensions, ["code-workspace"]);
      }
      if (channel === DESKTOP_IPC.saveWorkspace) assert.equal(options.defaultPath, "project.code-workspace");
    }
  }
});
