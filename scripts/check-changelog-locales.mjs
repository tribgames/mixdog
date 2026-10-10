// Verifies changelog/<lang>.md against CHANGELOG.md: same releases, same
// structure, and every machine-checkable token (code, links, issue refs,
// versions) preserved. Used by the desktop fast-lane test and, with
// --unreleased, by the Deploy release gate.
//
//   node scripts/check-changelog-locales.mjs [--unreleased]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Non-English UI languages (the keys of CATALOGS in the desktop i18n.ts). */
export const LOCALES = ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'ru', 'vi', 'zh-CN', 'zh-TW'];

const RELEASE_HEADING = /^v\d\S*(?:\s+-\s+\S+)?$/;

export function splitChangelog(text) {
  const [intro, ...parts] = text.replace(/\r\n/g, '\n').split(/^## /m);
  const sections = parts.map((part) => {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    return { heading, body: newline === -1 ? '' : part.slice(newline + 1) };
  });
  return { intro, sections };
}

const isUnreleased = (heading) => /^Unreleased\b/.test(heading);
const keyOf = (heading) => (isUnreleased(heading) ? 'Unreleased' : heading);

function selectSections(sections, includeUnreleased) {
  return sections
    .filter(({ heading }) => RELEASE_HEADING.test(heading) || (includeUnreleased && isUnreleased(heading)))
    .map((section) => ({ ...section, key: keyOf(section.heading) }));
}

function analyze(body) {
  const fences = [];
  const prose = [];
  const skeleton = [];
  const items = [];
  let fence = null;
  let current = null;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      current = null;
      if (fence) {
        fence.push(line);
        fences.push(fence.join('\n'));
        fence = null;
      } else {
        fence = [line];
        skeleton.push('F');
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    prose.push(line);
    const heading = /^(#{1,6})\s/.exec(line);
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) {
      skeleton.push(`H${heading[1].length}`);
      current = null;
    } else if (item) {
      skeleton.push(`L${item[1].length}`);
      current = { top: item[1].length === 0, lines: [item[2].trim()] };
      items.push(current);
    } else if (!line.trim()) {
      current = null;
    } else if (current) {
      current.lines.push(line.trim());
    }
  }
  if (fence) fences.push(fence.join('\n'));
  return {
    fences,
    skeleton,
    items: items.map((item) => ({ top: item.top, text: item.lines.join(' ') })),
    prose: prose.join('\n'),
  };
}

const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const URL = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+/g;
const LINK_TARGET = /\]\(\s*<?([^)\s>]+)/g;
const ISSUE_REF = /(?<![\w&/])#\d+\b/g;
const VERSION = /(?<![\w.])v?\d+\.\d+\.\d+(?:-[\w.]+)?(?!\w)/g;

function tokens(prose) {
  const code = [...prose.matchAll(CODE_SPAN)].map((match) => match[2].replace(/\s+/g, ' ').trim());
  const bare = prose.replace(CODE_SPAN, ' ');
  const urls = [...bare.matchAll(URL)].map((match) => match[0].replace(/[.,;:!?']+$/, ''));
  const targets = [...bare.matchAll(LINK_TARGET)].map((match) => match[1]);
  const rest = bare.replace(URL, ' ');
  return {
    'inline code': code,
    'link targets': [...urls, ...targets],
    'issue references': rest.match(ISSUE_REF) ?? [],
    'version strings': rest.match(VERSION) ?? [],
  };
}

function multisetDiff(expected, actual) {
  const counts = new Map();
  for (const value of expected) counts.set(value, (counts.get(value) ?? 0) + 1);
  const extra = [];
  for (const value of actual) {
    const left = counts.get(value) ?? 0;
    if (left > 0) counts.set(value, left - 1);
    else extra.push(value);
  }
  const missing = [...counts].flatMap(([value, left]) => Array(left).fill(value));
  return { missing, extra };
}

function compareMultiset(label, expected, actual, problems) {
  const { missing, extra } = multisetDiff(expected, actual);
  if (!missing.length && !extra.length) return;
  problems.push(`${label}: differs (missing: ${JSON.stringify(missing)}; unexpected: ${JSON.stringify(extra)})`);
}

const codeOnly = (text) => !/\p{L}/u.test(text.replace(CODE_SPAN, ' '));

function checkSection(label, englishBody, localeBody, problems) {
  const english = analyze(englishBody);
  const locale = analyze(localeBody);
  const topCount = (analysis) => analysis.items.filter((item) => item.top).length;
  if (topCount(english) !== topCount(locale)) {
    problems.push(`${label}: ${topCount(locale)} top-level list items, English has ${topCount(english)}`);
  }
  const structureMatches = english.skeleton.join(' ') === locale.skeleton.join(' ');
  if (!structureMatches) {
    problems.push(
      `${label}: structure differs (headings/lists/code blocks): expected [${english.skeleton.join(' ')}], got [${locale.skeleton.join(' ')}]`
    );
  }
  compareMultiset(`${label}: fenced code blocks`, english.fences, locale.fences, problems);
  const englishTokens = tokens(english.prose);
  const localeTokens = tokens(locale.prose);
  for (const kind of Object.keys(englishTokens)) {
    compareMultiset(`${label}: ${kind}`, englishTokens[kind], localeTokens[kind], problems);
  }
  if (structureMatches) {
    english.items.forEach((item, index) => {
      if (item.text === locale.items[index].text && !codeOnly(item.text)) {
        problems.push(`${label}: list item ${index + 1} is not translated: ${JSON.stringify(item.text.slice(0, 80))}`);
      }
    });
  }
}

/** Problems found in one locale file's text against the English changelog text. */
export function checkLocaleText(englishText, localeText, { includeUnreleased = false } = {}) {
  const problems = [];
  const english = splitChangelog(englishText);
  const locale = splitChangelog(localeText);
  if (english.intro.trim() === locale.intro.trim()) problems.push('intro: not translated (identical to English)');
  const englishSections = selectSections(english.sections, includeUnreleased);
  const localeSections = selectSections(locale.sections, includeUnreleased);
  const englishKeys = englishSections.map((section) => section.key);
  const localeKeys = localeSections.map((section) => section.key);
  const missing = englishKeys.filter((key) => !localeKeys.includes(key));
  const extra = localeKeys.filter((key) => !englishKeys.includes(key));
  for (const key of missing) problems.push(`${key}: section missing`);
  for (const key of extra) problems.push(`${key}: section not in CHANGELOG.md`);
  if (!missing.length && !extra.length && englishKeys.join('\n') !== localeKeys.join('\n')) {
    problems.push(`section order differs: expected [${englishKeys.join(', ')}], got [${localeKeys.join(', ')}]`);
  }
  for (const section of englishSections) {
    const match = localeSections.find((candidate) => candidate.key === section.key);
    if (match) checkSection(section.key, section.body, match.body, problems);
  }
  return problems;
}

/** Problems for every locale file under `<root>/changelog/`, prefixed with the file. */
export function checkChangelogLocales({
  root = join(dirname(fileURLToPath(import.meta.url)), '..'),
  includeUnreleased = false,
  locales = LOCALES,
} = {}) {
  const englishText = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  return locales.flatMap((language) => {
    const file = `changelog/${language}.md`;
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      return [`${file}: file is missing`];
    }
    return checkLocaleText(englishText, text, { includeUnreleased }).map((problem) => `${file}: ${problem}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkChangelogLocales({ includeUnreleased: process.argv.includes('--unreleased') });
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`check-changelog-locales: OK (${LOCALES.length} locales)`);
}
