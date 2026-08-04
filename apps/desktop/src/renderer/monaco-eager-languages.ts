// PANE language ids whose Monarch tokenizers monaco-setup.ts registers
// EAGERLY, mapped to their monaco basic-languages module directory.
//
// Why: basic-languages registers every language id synchronously but loads
// its Monarch tokenizer through a lazy dynamic import(); a model created
// before that chunk resolves paints untokenized (plain white) on entry
// (user: 스크립트/로그 진입 시 흰색 무강조). Eager registration removes the
// race for every language PANE can resolve to. Kept as a pure module so the
// renderer node tests can audit coverage without loading monaco.
//
// Deliberately absent: 'log' (our custom Monarch in monaco-log-language.ts),
// 'json' (tokenized by monaco's own JSON language mode), 'plaintext'.
export const MONACO_EAGER_MONARCH_LANGUAGES: Readonly<Record<string, string>> = {
  "bat": "bat",
  "c": "cpp",
  "clojure": "clojure",
  "coffeescript": "coffee",
  "cpp": "cpp",
  "csharp": "csharp",
  "css": "css",
  "dart": "dart",
  "dockerfile": "dockerfile",
  "fsharp": "fsharp",
  "go": "go",
  "handlebars": "handlebars",
  "html": "html",
  "ini": "ini",
  "java": "java",
  "javascript": "javascript",
  "julia": "julia",
  "less": "less",
  "lua": "lua",
  "markdown": "markdown",
  "objective-c": "objective-c",
  "perl": "perl",
  "php": "php",
  "powershell": "powershell",
  "pug": "pug",
  "python": "python",
  "r": "r",
  "razor": "razor",
  "restructuredtext": "restructuredtext",
  "ruby": "ruby",
  "rust": "rust",
  "scss": "scss",
  "shell": "shell",
  "sql": "sql",
  "swift": "swift",
  "typescript": "typescript",
  "vb": "vb",
  "xml": "xml",
  "yaml": "yaml",
};
