import pack from "./auto-i18n-pack.json";

const keys = [
  ...pack.keys0, ...pack.keys1, ...pack.keys2, ...pack.keys3, ...pack.keys4,
  ...pack.keys5, ...pack.keys6, ...pack.keys7, ...pack.keys8, ...pack.keys9,
];
const ko = [
  ...pack.ko0, ...pack.ko1, ...pack.ko2, ...pack.ko3, ...pack.ko4,
  ...pack.ko5, ...pack.ko6, ...pack.ko7, ...pack.ko8, ...pack.ko9,
];
const shared: Record<string, readonly string[]> = {
  ja: pack.ja,
  "zh-CN": pack["zh-CN"],
  "zh-TW": pack["zh-TW"],
  es: pack.es,
  fr: pack.fr,
  de: pack.de,
  it: pack.it,
  "pt-BR": pack["pt-BR"],
  ru: pack.ru,
  vi: pack.vi,
};

export function supplementalUiTranslations(language: string): Record<string, string> {
  if (language === "ko") {
    return {
      ...Object.fromEntries(keys.map((key, index) => [key, ko[index] || key])),
      "% used": "% 사용",
    };
  }
  const values = shared[language];
  if (!values) return {};
  return Object.fromEntries(pack.sharedIndices.map((keyIndex, index) => [
    keys[keyIndex],
    values[index] || keys[keyIndex],
  ]));
}

