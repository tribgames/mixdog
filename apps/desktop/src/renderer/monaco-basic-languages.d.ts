// monaco-editor ships its basic-languages Monarch definitions as plain ESM
// without declaration files (only the lazy *.contribution.d.ts). Declare the
// shape for every Monarch module monaco-setup.ts imports eagerly.
declare module "monaco-editor/esm/vs/basic-languages/*" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
