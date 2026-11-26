import type { LanguageFn } from 'highlight.js';
import { getSharedLowlight } from './shared-lowlight';

type GrammarLoader = () => Promise<{ default: LanguageFn }>;

const EXTRA_LANGUAGE_LOADERS: Record<string, GrammarLoader> = {
  '1c': () => import('highlight.js/lib/languages/1c'),
  abnf: () => import('highlight.js/lib/languages/abnf'),
  accesslog: () => import('highlight.js/lib/languages/accesslog'),
  actionscript: () => import('highlight.js/lib/languages/actionscript'),
  ada: () => import('highlight.js/lib/languages/ada'),
  angelscript: () => import('highlight.js/lib/languages/angelscript'),
  apache: () => import('highlight.js/lib/languages/apache'),
  applescript: () => import('highlight.js/lib/languages/applescript'),
  arcade: () => import('highlight.js/lib/languages/arcade'),
  armasm: () => import('highlight.js/lib/languages/armasm'),
  asciidoc: () => import('highlight.js/lib/languages/asciidoc'),
  aspectj: () => import('highlight.js/lib/languages/aspectj'),
  autohotkey: () => import('highlight.js/lib/languages/autohotkey'),
  autoit: () => import('highlight.js/lib/languages/autoit'),
  avrasm: () => import('highlight.js/lib/languages/avrasm'),
  awk: () => import('highlight.js/lib/languages/awk'),
  axapta: () => import('highlight.js/lib/languages/axapta'),
  basic: () => import('highlight.js/lib/languages/basic'),
  bnf: () => import('highlight.js/lib/languages/bnf'),
  brainfuck: () => import('highlight.js/lib/languages/brainfuck'),
  cal: () => import('highlight.js/lib/languages/cal'),
  capnproto: () => import('highlight.js/lib/languages/capnproto'),
  ceylon: () => import('highlight.js/lib/languages/ceylon'),
  clean: () => import('highlight.js/lib/languages/clean'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  'clojure-repl': () => import('highlight.js/lib/languages/clojure-repl'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  coffeescript: () => import('highlight.js/lib/languages/coffeescript'),
  coq: () => import('highlight.js/lib/languages/coq'),
  cos: () => import('highlight.js/lib/languages/cos'),
  crmsh: () => import('highlight.js/lib/languages/crmsh'),
  crystal: () => import('highlight.js/lib/languages/crystal'),
  csp: () => import('highlight.js/lib/languages/csp'),
  d: () => import('highlight.js/lib/languages/d'),
  dart: () => import('highlight.js/lib/languages/dart'),
  delphi: () => import('highlight.js/lib/languages/delphi'),
  django: () => import('highlight.js/lib/languages/django'),
  dns: () => import('highlight.js/lib/languages/dns'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  dos: () => import('highlight.js/lib/languages/dos'),
  dsconfig: () => import('highlight.js/lib/languages/dsconfig'),
  dts: () => import('highlight.js/lib/languages/dts'),
  dust: () => import('highlight.js/lib/languages/dust'),
  ebnf: () => import('highlight.js/lib/languages/ebnf'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  elm: () => import('highlight.js/lib/languages/elm'),
  erb: () => import('highlight.js/lib/languages/erb'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  'erlang-repl': () => import('highlight.js/lib/languages/erlang-repl'),
  excel: () => import('highlight.js/lib/languages/excel'),
  fix: () => import('highlight.js/lib/languages/fix'),
  flix: () => import('highlight.js/lib/languages/flix'),
  fortran: () => import('highlight.js/lib/languages/fortran'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  gams: () => import('highlight.js/lib/languages/gams'),
  gauss: () => import('highlight.js/lib/languages/gauss'),
  gcode: () => import('highlight.js/lib/languages/gcode'),
  gherkin: () => import('highlight.js/lib/languages/gherkin'),
  glsl: () => import('highlight.js/lib/languages/glsl'),
  gml: () => import('highlight.js/lib/languages/gml'),
  golo: () => import('highlight.js/lib/languages/golo'),
  gradle: () => import('highlight.js/lib/languages/gradle'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  haml: () => import('highlight.js/lib/languages/haml'),
  handlebars: () => import('highlight.js/lib/languages/handlebars'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  haxe: () => import('highlight.js/lib/languages/haxe'),
  hsp: () => import('highlight.js/lib/languages/hsp'),
  http: () => import('highlight.js/lib/languages/http'),
  hy: () => import('highlight.js/lib/languages/hy'),
  inform7: () => import('highlight.js/lib/languages/inform7'),
  irpf90: () => import('highlight.js/lib/languages/irpf90'),
  isbl: () => import('highlight.js/lib/languages/isbl'),
  'jboss-cli': () => import('highlight.js/lib/languages/jboss-cli'),
  julia: () => import('highlight.js/lib/languages/julia'),
  'julia-repl': () => import('highlight.js/lib/languages/julia-repl'),
  lasso: () => import('highlight.js/lib/languages/lasso'),
  latex: () => import('highlight.js/lib/languages/latex'),
  ldif: () => import('highlight.js/lib/languages/ldif'),
  leaf: () => import('highlight.js/lib/languages/leaf'),
  lisp: () => import('highlight.js/lib/languages/lisp'),
  livecodeserver: () => import('highlight.js/lib/languages/livecodeserver'),
  livescript: () => import('highlight.js/lib/languages/livescript'),
  llvm: () => import('highlight.js/lib/languages/llvm'),
  lsl: () => import('highlight.js/lib/languages/lsl'),
  mathematica: () => import('highlight.js/lib/languages/mathematica'),
  matlab: () => import('highlight.js/lib/languages/matlab'),
  maxima: () => import('highlight.js/lib/languages/maxima'),
  mel: () => import('highlight.js/lib/languages/mel'),
  mercury: () => import('highlight.js/lib/languages/mercury'),
  mipsasm: () => import('highlight.js/lib/languages/mipsasm'),
  mizar: () => import('highlight.js/lib/languages/mizar'),
  mojolicious: () => import('highlight.js/lib/languages/mojolicious'),
  monkey: () => import('highlight.js/lib/languages/monkey'),
  moonscript: () => import('highlight.js/lib/languages/moonscript'),
  n1ql: () => import('highlight.js/lib/languages/n1ql'),
  nestedtext: () => import('highlight.js/lib/languages/nestedtext'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  nim: () => import('highlight.js/lib/languages/nim'),
  nix: () => import('highlight.js/lib/languages/nix'),
  'node-repl': () => import('highlight.js/lib/languages/node-repl'),
  nsis: () => import('highlight.js/lib/languages/nsis'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  openscad: () => import('highlight.js/lib/languages/openscad'),
  oxygene: () => import('highlight.js/lib/languages/oxygene'),
  parser3: () => import('highlight.js/lib/languages/parser3'),
  pf: () => import('highlight.js/lib/languages/pf'),
  pgsql: () => import('highlight.js/lib/languages/pgsql'),
  pony: () => import('highlight.js/lib/languages/pony'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  processing: () => import('highlight.js/lib/languages/processing'),
  profile: () => import('highlight.js/lib/languages/profile'),
  prolog: () => import('highlight.js/lib/languages/prolog'),
  properties: () => import('highlight.js/lib/languages/properties'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  puppet: () => import('highlight.js/lib/languages/puppet'),
  purebasic: () => import('highlight.js/lib/languages/purebasic'),
  q: () => import('highlight.js/lib/languages/q'),
  qml: () => import('highlight.js/lib/languages/qml'),
  reasonml: () => import('highlight.js/lib/languages/reasonml'),
  rib: () => import('highlight.js/lib/languages/rib'),
  roboconf: () => import('highlight.js/lib/languages/roboconf'),
  routeros: () => import('highlight.js/lib/languages/routeros'),
  rsl: () => import('highlight.js/lib/languages/rsl'),
  ruleslanguage: () => import('highlight.js/lib/languages/ruleslanguage'),
  sas: () => import('highlight.js/lib/languages/sas'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scheme: () => import('highlight.js/lib/languages/scheme'),
  scilab: () => import('highlight.js/lib/languages/scilab'),
  smali: () => import('highlight.js/lib/languages/smali'),
  smalltalk: () => import('highlight.js/lib/languages/smalltalk'),
  sml: () => import('highlight.js/lib/languages/sml'),
  sqf: () => import('highlight.js/lib/languages/sqf'),
  stan: () => import('highlight.js/lib/languages/stan'),
  stata: () => import('highlight.js/lib/languages/stata'),
  step21: () => import('highlight.js/lib/languages/step21'),
  stylus: () => import('highlight.js/lib/languages/stylus'),
  subunit: () => import('highlight.js/lib/languages/subunit'),
  taggerscript: () => import('highlight.js/lib/languages/taggerscript'),
  tap: () => import('highlight.js/lib/languages/tap'),
  tcl: () => import('highlight.js/lib/languages/tcl'),
  thrift: () => import('highlight.js/lib/languages/thrift'),
  tp: () => import('highlight.js/lib/languages/tp'),
  twig: () => import('highlight.js/lib/languages/twig'),
  vala: () => import('highlight.js/lib/languages/vala'),
  vbscript: () => import('highlight.js/lib/languages/vbscript'),
  'vbscript-html': () => import('highlight.js/lib/languages/vbscript-html'),
  verilog: () => import('highlight.js/lib/languages/verilog'),
  vhdl: () => import('highlight.js/lib/languages/vhdl'),
  vim: () => import('highlight.js/lib/languages/vim'),
  wren: () => import('highlight.js/lib/languages/wren'),
  x86asm: () => import('highlight.js/lib/languages/x86asm'),
  xl: () => import('highlight.js/lib/languages/xl'),
  xquery: () => import('highlight.js/lib/languages/xquery'),
  zephir: () => import('highlight.js/lib/languages/zephir'),
};

const EXTRA_LANGUAGE_ALIASES: Record<string, string> = {
  as: 'actionscript',
  asc: 'angelscript',
  apacheconf: 'apache',
  osascript: 'applescript',
  arm: 'armasm',
  adoc: 'asciidoc',
  ahk: 'autohotkey',
  'x++': 'axapta',
  bf: 'brainfuck',
  capnp: 'capnproto',
  icl: 'clean',
  dcl: 'clean',
  clj: 'clojure',
  edn: 'clojure',
  'cmake.in': 'cmake',
  coffee: 'coffeescript',
  cson: 'coffeescript',
  iced: 'coffeescript',
  cls: 'cos',
  crm: 'crmsh',
  pcmk: 'crmsh',
  cr: 'crystal',
  dpr: 'delphi',
  dfm: 'delphi',
  pas: 'delphi',
  pascal: 'delphi',
  jinja: 'django',
  bind: 'dns',
  zone: 'dns',
  docker: 'dockerfile',
  bat: 'dos',
  cmd: 'dos',
  dst: 'dust',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  xlsx: 'excel',
  xls: 'excel',
  f90: 'fortran',
  f95: 'fortran',
  fs: 'fsharp',
  'f#': 'fsharp',
  gms: 'gams',
  gss: 'gauss',
  nc: 'gcode',
  feature: 'gherkin',
  hbs: 'handlebars',
  'html.hbs': 'handlebars',
  'html.handlebars': 'handlebars',
  htmlbars: 'handlebars',
  hs: 'haskell',
  hx: 'haxe',
  https: 'http',
  hylang: 'hy',
  i7: 'inform7',
  'wildfly-cli': 'jboss-cli',
  jl: 'julia',
  jldoctest: 'julia-repl',
  ls: 'livescript',
  lassoscript: 'lasso',
  tex: 'latex',
  mma: 'mathematica',
  wl: 'mathematica',
  m: 'mercury',
  moo: 'mercury',
  mips: 'mipsasm',
  moon: 'moonscript',
  nt: 'nestedtext',
  nginxconf: 'nginx',
  nixos: 'nix',
  ml: 'sml',
  mli: 'ocaml',
  scad: 'openscad',
  'pf.conf': 'pf',
  postgres: 'pgsql',
  postgresql: 'pgsql',
  pwsh: 'powershell',
  ps: 'powershell',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  pde: 'processing',
  proto: 'protobuf',
  pp: 'puppet',
  pb: 'purebasic',
  pbi: 'purebasic',
  k: 'q',
  kdb: 'q',
  qt: 'qml',
  re: 'reasonml',
  graph: 'roboconf',
  instances: 'roboconf',
  mikrotik: 'routeros',
  scm: 'scheme',
  sci: 'scilab',
  st: 'smalltalk',
  stanfuncs: 'stan',
  do: 'stata',
  ado: 'stata',
  p21: 'step21',
  step: 'step21',
  stp: 'step21',
  styl: 'stylus',
  tk: 'tcl',
  craftcms: 'twig',
  vbs: 'vbscript',
  v: 'verilog',
  sv: 'verilog',
  svh: 'verilog',
  tao: 'xl',
  xpath: 'xquery',
  xq: 'xquery',
  xqm: 'xquery',
  zep: 'zephir',
};

const hljsDefineVue: LanguageFn = (hljs) => ({
  subLanguage: 'xml',
  contains: [
    hljs.COMMENT('<!--', '-->', { relevance: 10 }),
    {
      begin: /^(\s*)(<script>)/gm,
      end: /^(\s*)(<\/script>)/gm,
      subLanguage: 'javascript',
      excludeBegin: true,
      excludeEnd: true,
    },
    {
      begin: /^(?:\s*)(?:<script\s+lang=(["'])ts\1>)/gm,
      end: /^(\s*)(<\/script>)/gm,
      subLanguage: 'typescript',
      excludeBegin: true,
      excludeEnd: true,
    },
    {
      begin: /^(\s*)(<style(\s+scoped)?>)/gm,
      end: /^(\s*)(<\/style>)/gm,
      subLanguage: 'css',
      excludeBegin: true,
      excludeEnd: true,
    },
    {
      begin: /^(?:\s*)(?:<style(?:\s+scoped)?\s+lang=(["'])(?:s[ca]ss)\1(?:\s+scoped)?>)/gm,
      end: /^(\s*)(<\/style>)/gm,
      subLanguage: 'scss',
      excludeBegin: true,
      excludeEnd: true,
    },
    {
      begin: /^(?:\s*)(?:<style(?:\s+scoped)?\s+lang=(["'])stylus\1(?:\s+scoped)?>)/gm,
      end: /^(\s*)(<\/style>)/gm,
      subLanguage: 'stylus',
      excludeBegin: true,
      excludeEnd: true,
    },
  ],
});

function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
}

export function resolveBasenameHighlightLanguage(fileName?: string | null): string | null {
  if (!fileName) return null;
  const base = basenameOf(fileName);
  if (!base) return null;
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return 'dockerfile';
  if (base === 'cmakelists.txt') return 'cmake';
  if (base === 'jenkinsfile') return 'groovy';
  return null;
}

function canonicalExtraLanguage(candidate: string): string | null {
  const key = candidate.trim().toLowerCase();
  if (!key) return null;
  if (key === 'vue') return 'vue';
  if (Object.hasOwn(EXTRA_LANGUAGE_LOADERS, key)) return key;
  const aliased = EXTRA_LANGUAGE_ALIASES[key];
  if (aliased) return aliased;
  return null;
}

/** Resolves a non-`common` highlight.js language id from a diff language hint or file path. */
export function resolveDiffHighlightLanguage(lang?: string | null, fileName?: string | null): string | null {
  const fromBase = resolveBasenameHighlightLanguage(fileName);
  if (fromBase) return fromBase;
  if (lang) {
    const direct = canonicalExtraLanguage(lang);
    if (direct) return direct;
    const fromLangBase = resolveBasenameHighlightLanguage(lang);
    if (fromLangBase) return fromLangBase;
  }
  if (fileName) {
    const base = basenameOf(fileName);
    const dot = base.lastIndexOf('.');
    if (dot >= 0 && dot < base.length - 1) {
      const ext = canonicalExtraLanguage(base.slice(dot + 1));
      if (ext) return ext;
    }
  }
  return null;
}

const loadingLanguages = new Map<string, Promise<boolean>>();

/** Loads and registers a single non-`common` highlight.js grammar onto the shared lowlight instance on demand. */
export function ensureSharedLowlightLanguage(lang?: string | null, fileName?: string | null): Promise<boolean> {
  const canonical = resolveDiffHighlightLanguage(lang, fileName);
  if (!canonical) return Promise.resolve(false);
  const lowlight = getSharedLowlight();
  if (lowlight.registered(canonical)) return Promise.resolve(false);
  const existing = loadingLanguages.get(canonical);
  if (existing) return existing;
  const pending = (async () => {
    if (canonical === 'vue') {
      await ensureSharedLowlightLanguage('stylus').catch(() => false);
      if (!lowlight.registered('vue')) lowlight.register('vue', hljsDefineVue);
      return true;
    }
    const loader = EXTRA_LANGUAGE_LOADERS[canonical];
    if (!loader) return false;
    const mod = await loader();
    if (!lowlight.registered(canonical)) lowlight.register(canonical, mod.default);
    return true;
  })()
    .catch(() => false)
    .finally(() => {
      loadingLanguages.delete(canonical);
    });
  loadingLanguages.set(canonical, pending);
  return pending;
}

export async function ensureSharedLowlightLanguages(
  targets: ReadonlyArray<{ lang?: string | null; fileName?: string | null }>
): Promise<boolean> {
  const results = await Promise.all(
    targets.map((target) => ensureSharedLowlightLanguage(target.lang, target.fileName))
  );
  return results.some(Boolean);
}
