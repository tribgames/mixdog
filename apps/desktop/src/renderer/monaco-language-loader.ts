import type { languages } from 'monaco-editor';
import { MONACO_EAGER_MONARCH_LANGUAGES } from './monaco-eager-languages';

export interface MonacoBasicLanguageModule {
  conf: languages.LanguageConfiguration;
  language: languages.IMonarchLanguage;
}

export type MonacoBasicLanguageLoader = () => Promise<MonacoBasicLanguageModule>;

export interface MonacoLanguageRegistrar {
  setMonarchTokensProvider(languageId: string, language: languages.IMonarchLanguage): unknown;
  setLanguageConfiguration(languageId: string, configuration: languages.LanguageConfiguration): unknown;
}

export const MONACO_BASIC_LANGUAGE_LOADERS: Readonly<Record<string, MonacoBasicLanguageLoader>> = {
  bat: () => import('monaco-editor/esm/vs/basic-languages/bat/bat.js'),
  clojure: () => import('monaco-editor/esm/vs/basic-languages/clojure/clojure.js'),
  coffee: () => import('monaco-editor/esm/vs/basic-languages/coffee/coffee.js'),
  cpp: () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.js'),
  csharp: () => import('monaco-editor/esm/vs/basic-languages/csharp/csharp.js'),
  css: () => import('monaco-editor/esm/vs/basic-languages/css/css.js'),
  dart: () => import('monaco-editor/esm/vs/basic-languages/dart/dart.js'),
  dockerfile: () => import('monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.js'),
  fsharp: () => import('monaco-editor/esm/vs/basic-languages/fsharp/fsharp.js'),
  go: () => import('monaco-editor/esm/vs/basic-languages/go/go.js'),
  handlebars: () => import('monaco-editor/esm/vs/basic-languages/handlebars/handlebars.js'),
  html: () => import('monaco-editor/esm/vs/basic-languages/html/html.js'),
  ini: () => import('monaco-editor/esm/vs/basic-languages/ini/ini.js'),
  java: () => import('monaco-editor/esm/vs/basic-languages/java/java.js'),
  javascript: () => import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js'),
  julia: () => import('monaco-editor/esm/vs/basic-languages/julia/julia.js'),
  less: () => import('monaco-editor/esm/vs/basic-languages/less/less.js'),
  lua: () => import('monaco-editor/esm/vs/basic-languages/lua/lua.js'),
  markdown: () => import('monaco-editor/esm/vs/basic-languages/markdown/markdown.js'),
  'objective-c': () => import('monaco-editor/esm/vs/basic-languages/objective-c/objective-c.js'),
  perl: () => import('monaco-editor/esm/vs/basic-languages/perl/perl.js'),
  php: () => import('monaco-editor/esm/vs/basic-languages/php/php.js'),
  powershell: () => import('monaco-editor/esm/vs/basic-languages/powershell/powershell.js'),
  pug: () => import('monaco-editor/esm/vs/basic-languages/pug/pug.js'),
  python: () => import('monaco-editor/esm/vs/basic-languages/python/python.js'),
  r: () => import('monaco-editor/esm/vs/basic-languages/r/r.js'),
  razor: () => import('monaco-editor/esm/vs/basic-languages/razor/razor.js'),
  restructuredtext: () => import('monaco-editor/esm/vs/basic-languages/restructuredtext/restructuredtext.js'),
  ruby: () => import('monaco-editor/esm/vs/basic-languages/ruby/ruby.js'),
  rust: () => import('monaco-editor/esm/vs/basic-languages/rust/rust.js'),
  scss: () => import('monaco-editor/esm/vs/basic-languages/scss/scss.js'),
  shell: () => import('monaco-editor/esm/vs/basic-languages/shell/shell.js'),
  sql: () => import('monaco-editor/esm/vs/basic-languages/sql/sql.js'),
  swift: () => import('monaco-editor/esm/vs/basic-languages/swift/swift.js'),
  typescript: () => import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js'),
  vb: () => import('monaco-editor/esm/vs/basic-languages/vb/vb.js'),
  xml: () => import('monaco-editor/esm/vs/basic-languages/xml/xml.js'),
  yaml: () => import('monaco-editor/esm/vs/basic-languages/yaml/yaml.js'),
};

export interface MonacoLanguageLoaderController {
  ensureLanguage(languageId: string | undefined): Promise<boolean>;
  isLoaded(languageId: string): boolean;
}

export function createMonacoLanguageLoader({
  languageDirs = MONACO_EAGER_MONARCH_LANGUAGES,
  loaders = MONACO_BASIC_LANGUAGE_LOADERS,
  register,
}: {
  languageDirs?: Readonly<Record<string, string>>;
  loaders?: Readonly<Record<string, MonacoBasicLanguageLoader>>;
  register: MonacoLanguageRegistrar;
}): MonacoLanguageLoaderController {
  const moduleLoads = new Map<string, Promise<MonacoBasicLanguageModule>>();
  const languageLoads = new Map<string, Promise<boolean>>();
  const loadedLanguages = new Set<string>();

  const loadModule = (moduleDir: string, loader: MonacoBasicLanguageLoader): Promise<MonacoBasicLanguageModule> => {
    const existing = moduleLoads.get(moduleDir);
    if (existing) return existing;
    const pending = loader().catch((error: unknown) => {
      if (moduleLoads.get(moduleDir) === pending) moduleLoads.delete(moduleDir);
      throw error;
    });
    moduleLoads.set(moduleDir, pending);
    return pending;
  };

  return {
    ensureLanguage(languageId: string | undefined): Promise<boolean> {
      if (!languageId) return Promise.resolve(false);
      const moduleDir = languageDirs[languageId];
      const loader = moduleDir ? loaders[moduleDir] : undefined;
      if (!moduleDir || !loader) return Promise.resolve(false);
      const existing = languageLoads.get(languageId);
      if (existing) return existing;
      const pending = loadModule(moduleDir, loader)
        .then((definition) => {
          register.setMonarchTokensProvider(languageId, definition.language);
          register.setLanguageConfiguration(languageId, definition.conf);
          loadedLanguages.add(languageId);
          return true;
        })
        .catch((error: unknown) => {
          if (languageLoads.get(languageId) === pending) languageLoads.delete(languageId);
          throw error;
        });
      languageLoads.set(languageId, pending);
      return pending;
    },
    isLoaded(languageId: string): boolean {
      return loadedLanguages.has(languageId);
    },
  };
}

let activeLanguageLoader: MonacoLanguageLoaderController | null = null;

export function installMonacoLanguageLoader(controller: MonacoLanguageLoaderController): void {
  activeLanguageLoader = controller;
}

export function ensureMonacoLanguage(languageId: string | undefined): Promise<boolean> {
  return activeLanguageLoader ? activeLanguageLoader.ensureLanguage(languageId) : Promise.resolve(false);
}
