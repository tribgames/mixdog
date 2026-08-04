// i18n catalog sync for the desktop renderer (npm run i18n:sync).
// English source text IS the key: only ko.json exists on disk, and a key
// missing from it renders its English original at runtime.
// removeUnusedKeys stays false because many keys reach t() through the
// settings primitives (Group/SelectRow/ActionButton…) as variables the
// static extractor cannot see — pruning would delete live translations.
export default {
  locales: ["ko", "ja", "zh-CN", "zh-TW", "es", "fr", "de", "it", "pt-BR", "ru", "vi"],
  extract: {
    input: ["src/renderer/**/*.{ts,tsx}"],
    ignore: ["src/renderer/**/*.test.*", "src/renderer/locales/**"],
    output: "src/renderer/locales/{{language}}.json",
    functions: ["t"],
    nsSeparator: false,
    keySeparator: false,
    defaultValue: "",
    removeUnusedKeys: false,
    sort: true,
  },
};
