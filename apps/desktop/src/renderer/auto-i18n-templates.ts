type Template = { key: string; names: string[]; expression: RegExp; specificity: number };
let cachedKeys: string[] = [];
let cachedTemplates: Template[] = [];

/** Count placeholders only ever carry a number. Letting them swallow any run
 *  of words matched "…stop active tasks" against "{{count}} tasks" and painted
 *  a button as "작업 Save authorization and stop active개". */
const NUMERIC_PLACEHOLDER = /count$/i;

/** Exact labels win at the caller. Templates need literal words and are
 * ordered most-specific first; an identity template must not swallow a
 * translatable phrase. Captured user values are never translated. */
export function uiTranslationTemplates(keys: string[]): readonly Template[] {
  if (keys === cachedKeys) {
    return cachedTemplates;
  }
  cachedKeys = keys;
  cachedTemplates = keys.flatMap((key): Template[] => {
    const literal = key.replace(/\{\{[^}]+\}\}/g, "");
    if (!/[A-Za-z]/.test(literal) || literal === key) return [];
    const names: string[] = [];
    let cursor = 0;
    let expression = "^";
    for (const match of key.matchAll(/\{\{([^}]+)\}\}/g)) {
      expression += key.slice(cursor, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expression += NUMERIC_PLACEHOLDER.test(match[1]) ? "(\\d[\\d.,]*)" : "(.*?)";
      names.push(match[1]);
      cursor = match.index! + match[0].length;
    }
    expression += key.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
    return [{ key, names, expression: new RegExp(expression), specificity: literal.length }];
  }).sort((a, b) => b.specificity - a.specificity);
  return cachedTemplates;
}
