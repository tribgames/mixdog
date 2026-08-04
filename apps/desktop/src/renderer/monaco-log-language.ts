import type { languages } from "monaco-editor";

/** Monaco counterpart of VS Code's built-in extensions/log TextMate grammar. */
export const LOG_LANGUAGE_CONFIGURATION: languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [["[", "]"], ["(", ")"], ["{", "}"]],
  autoClosingPairs: [
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "{", close: "}" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

export const LOG_MONARCH_LANGUAGE: languages.IMonarchLanguage = {
  defaultToken: "",
  ignoreCase: true,
  tokenizer: {
    root: [
      [/\btrace\b:?|\[(?:verbose|verb|vrb|vb|v)\]/, "comment"],
      [/\bdebug\b:?|\[(?:debug|dbug|dbg|de|d)\]/, "keyword"],
      [/\b(?:hint|info|information|notice|ii)\b:?|\[(?:information|info|inf|in|i)\]/, "type"],
      [/\b(?:warning|warn|ww)\b:?|\[(?:warning|warn|wrn|wn|w)\]/, "number"],
      [/\b(?:alert|critical|emergency|error|failure|fail|fatal|ee)\b:?|\[(?:error|eror|err|er|e|fatal|fatl|ftl|fa|f)\]/, "regexp"],
      [/\b\d{4}-\d{2}-\d{2}(?=T|\b)/, "comment"],
      [/\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z| ?[+-]\d{1,2}:?\d{2})?\b/, "comment"],
      [/\b[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}\b/, "number"],
      [/\b(?:[0-9a-f]{40}|[0-9a-f]{10}|[0-9a-f]{7})\b/, "number"],
      [/\b0x[a-f0-9]+\b|\b(?:\d+|true|false|null)\b/, "number"],
      [/"[^"]*"/, "string"],
      [/'[^']*'/, "string"],
      [/\b[a-z.]*Exception\b/, "regexp"],
      [/^\s*at\s.*$/, "string"],
      [/\b[a-z]+:\/\/\S+\b\/?/, "type"],
      [/(?:^|[^\w/\\])(?:[\w-]+\.)+[\w-]+(?![\w/\\])/, "type"],
    ],
  },
};
