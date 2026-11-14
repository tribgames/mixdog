// The fixed words of a server's notifications. The core that raises them (a link lost or back, a tool waiting for approval, a
// turn that failed) has no UI language: it sends the English text, and this PC's desktop shows it in the language of its
// own window, as it did when the desktop raised these notifications itself.

/** The bodies the core sends, as the keys of the UI translation table. */
const FIXED_BODIES: readonly string[] = [
  'A tool is waiting for your approval.',
  'The turn stopped with an error.',
  'Mixdog is reconnecting automatically.',
  'Open the server window to reconnect.',
  'The server window is working again.',
];

/** The titles the core sends with the server's name in `{{name}}`, as the keys of the UI translation table. */
const NAMED_TITLES: readonly string[] = ['Connection to {{name}} lost', 'Reconnected to {{name}}'];

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const TITLE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = NAMED_TITLES.map((template) => [
  template,
  new RegExp(`^${escapePattern(template).replace(escapePattern('{{name}}'), '(.+)')}$`, 'su'),
]);

export interface NoticeText {
  title: string;
  body: string;
}

/** `content` with the fixed words of a server's notification translated by `translate` (the UI translation of an English
 *  key); everything else is the core's own text and stays as it is. */
export function localizeServerNotice(content: NoticeText, translate: (key: string) => string): NoticeText {
  let { title, body } = content;
  if (FIXED_BODIES.includes(body)) body = translate(body);
  for (const [template, pattern] of TITLE_PATTERNS) {
    const name = pattern.exec(title)?.[1];
    if (name !== undefined) {
      title = translate(template).replaceAll('{{name}}', name);
      break;
    }
  }
  return { title, body };
}
