import type { Editor } from '@tiptap/core';

export type RichMarkdownPromptKind = 'link' | 'image' | 'inlineMath' | 'blockMath';

export interface RichMarkdownBlockCommand {
  id: string;
  /** English label; rendered through t(). */
  label: string;
  /** Values for `{{placeholders}}` in `label`. */
  labelParams?: { level: number };
  keywords: string[];
  /** Runs after the typed `/query` has been removed. `prompt` opens the
   *  editor's input popover for commands that need a value. */
  run(editor: Editor, prompt: (kind: RichMarkdownPromptKind) => void): void;
}

const heading = (level: 1 | 2 | 3 | 4 | 5 | 6): RichMarkdownBlockCommand => ({
  id: `heading${level}`,
  label: 'Heading {{level}}',
  labelParams: { level },
  keywords: ['heading', `h${level}`, 'title'],
  run: (editor) => editor.chain().focus().setHeading({ level }).run(),
});

export const RICH_MARKDOWN_BLOCK_COMMANDS: RichMarkdownBlockCommand[] = [
  {
    id: 'paragraph',
    label: 'Text',
    keywords: ['paragraph', 'text', 'plain'],
    run: (editor) => editor.chain().focus().setParagraph().run(),
  },
  heading(1),
  heading(2),
  heading(3),
  heading(4),
  heading(5),
  heading(6),
  {
    id: 'bulletList',
    label: 'Bulleted list',
    keywords: ['bullet', 'unordered', 'ul', 'list'],
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'orderedList',
    label: 'Numbered list',
    keywords: ['numbered', 'ordered', 'ol', 'list'],
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'taskList',
    label: 'Task list',
    keywords: ['task', 'todo', 'checkbox', 'check'],
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'blockquote',
    label: 'Quote',
    keywords: ['quote', 'blockquote', 'citation'],
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'codeBlock',
    label: 'Code block',
    keywords: ['code', 'fence', 'snippet', 'pre'],
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'table',
    label: 'Table',
    keywords: ['table', 'grid', 'columns'],
    run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'horizontalRule',
    label: 'Divider',
    keywords: ['divider', 'rule', 'hr', 'separator', 'line'],
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'details',
    label: 'Collapsible section',
    keywords: ['details', 'toggle', 'collapse', 'summary', 'fold'],
    run: (editor) => editor.chain().focus().setDetails().run(),
  },
  {
    id: 'blockMath',
    label: 'Math block',
    keywords: ['math', 'equation', 'latex', 'katex', 'formula'],
    run: (_editor, prompt) => prompt('blockMath'),
  },
  {
    id: 'inlineMath',
    label: 'Inline math',
    keywords: ['math', 'inline', 'latex', 'katex', 'formula'],
    run: (_editor, prompt) => prompt('inlineMath'),
  },
  {
    id: 'image',
    label: 'Image',
    keywords: ['image', 'picture', 'photo', 'img'],
    run: (_editor, prompt) => prompt('image'),
  },
  {
    id: 'link',
    label: 'Link',
    keywords: ['link', 'url', 'href'],
    run: (_editor, prompt) => prompt('link'),
  },
];

/** Commands matching a `/query`: label or keyword prefix first, then any
 *  substring match, each group in menu order. */
export function filterBlockCommands(
  query: string,
  label: (english: string, params?: { level: number }) => string = (text, params) =>
    params ? text.replace('{{level}}', String(params.level)) : text
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return RICH_MARKDOWN_BLOCK_COMMANDS;
  const words = (command: RichMarkdownBlockCommand) => [
    label(command.label, command.labelParams).toLowerCase(),
    ...(command.labelParams ? [`heading ${command.labelParams.level}`] : [command.label.toLowerCase()]),
    ...command.keywords,
  ];
  const prefix = RICH_MARKDOWN_BLOCK_COMMANDS.filter((command) =>
    words(command).some((word) => word.startsWith(needle) || word.split(/\s+/).some((part) => part.startsWith(needle)))
  );
  const rest = RICH_MARKDOWN_BLOCK_COMMANDS.filter(
    (command) => !prefix.includes(command) && words(command).some((word) => word.includes(needle))
  );
  return [...prefix, ...rest];
}

/** Common GitHub shortcodes. */
const RICH_MARKDOWN_EMOJI: ReadonlyArray<readonly [string, string]> = [
  ['smile', '😄'],
  ['grin', '😁'],
  ['joy', '😂'],
  ['laughing', '😆'],
  ['wink', '😉'],
  ['blush', '😊'],
  ['slightly_smiling_face', '🙂'],
  ['upside_down_face', '🙃'],
  ['heart_eyes', '😍'],
  ['kissing_heart', '😘'],
  ['thinking', '🤔'],
  ['neutral_face', '😐'],
  ['expressionless', '😑'],
  ['unamused', '😒'],
  ['roll_eyes', '🙄'],
  ['grimacing', '😬'],
  ['relieved', '😌'],
  ['pensive', '😔'],
  ['sleepy', '😪'],
  ['sleeping', '😴'],
  ['sunglasses', '😎'],
  ['nerd_face', '🤓'],
  ['confused', '😕'],
  ['worried', '😟'],
  ['open_mouth', '😮'],
  ['astonished', '😲'],
  ['flushed', '😳'],
  ['cry', '😢'],
  ['sob', '😭'],
  ['scream', '😱'],
  ['angry', '😠'],
  ['rage', '😡'],
  ['skull', '💀'],
  ['clown_face', '🤡'],
  ['ghost', '👻'],
  ['alien', '👽'],
  ['robot', '🤖'],
  ['poop', '💩'],
  ['see_no_evil', '🙈'],
  ['wave', '👋'],
  ['ok_hand', '👌'],
  ['v', '✌️'],
  ['crossed_fingers', '🤞'],
  ['point_right', '👉'],
  ['point_left', '👈'],
  ['point_up', '☝️'],
  ['point_down', '👇'],
  ['thumbsup', '👍'],
  ['+1', '👍'],
  ['thumbsdown', '👎'],
  ['-1', '👎'],
  ['clap', '👏'],
  ['raised_hands', '🙌'],
  ['pray', '🙏'],
  ['handshake', '🤝'],
  ['muscle', '💪'],
  ['eyes', '👀'],
  ['brain', '🧠'],
  ['heart', '❤️'],
  ['orange_heart', '🧡'],
  ['yellow_heart', '💛'],
  ['green_heart', '💚'],
  ['blue_heart', '💙'],
  ['purple_heart', '💜'],
  ['broken_heart', '💔'],
  ['sparkles', '✨'],
  ['star', '⭐'],
  ['star2', '🌟'],
  ['zap', '⚡'],
  ['fire', '🔥'],
  ['boom', '💥'],
  ['tada', '🎉'],
  ['confetti_ball', '🎊'],
  ['gift', '🎁'],
  ['trophy', '🏆'],
  ['medal_sports', '🏅'],
  ['rocket', '🚀'],
  ['airplane', '✈️'],
  ['car', '🚗'],
  ['ship', '🚢'],
  ['house', '🏠'],
  ['office', '🏢'],
  ['sun', '☀️'],
  ['cloud', '☁️'],
  ['umbrella', '☂️'],
  ['snowflake', '❄️'],
  ['rainbow', '🌈'],
  ['ocean', '🌊'],
  ['seedling', '🌱'],
  ['evergreen_tree', '🌲'],
  ['cactus', '🌵'],
  ['four_leaf_clover', '🍀'],
  ['apple', '🍎'],
  ['coffee', '☕'],
  ['beer', '🍺'],
  ['pizza', '🍕'],
  ['cake', '🍰'],
  ['dog', '🐶'],
  ['cat', '🐱'],
  ['bug', '🐛'],
  ['bee', '🐝'],
  ['turtle', '🐢'],
  ['snake', '🐍'],
  ['whale', '🐳'],
  ['penguin', '🐧'],
  ['unicorn', '🦄'],
  ['bulb', '💡'],
  ['memo', '📝'],
  ['pencil2', '✏️'],
  ['book', '📖'],
  ['books', '📚'],
  ['bookmark', '🔖'],
  ['link', '🔗'],
  ['paperclip', '📎'],
  ['pushpin', '📌'],
  ['calendar', '📅'],
  ['chart_with_upwards_trend', '📈'],
  ['chart_with_downwards_trend', '📉'],
  ['bar_chart', '📊'],
  ['clipboard', '📋'],
  ['file_folder', '📁'],
  ['package', '📦'],
  ['email', '📧'],
  ['bell', '🔔'],
  ['mag', '🔍'],
  ['lock', '🔒'],
  ['unlock', '🔓'],
  ['key', '🔑'],
  ['hammer', '🔨'],
  ['wrench', '🔧'],
  ['gear', '⚙️'],
  ['hourglass', '⌛'],
  ['alarm_clock', '⏰'],
  ['computer', '💻'],
  ['keyboard', '⌨️'],
  ['iphone', '📱'],
  ['art', '🎨'],
  ['dart', '🎯'],
  ['construction', '🚧'],
  ['warning', '⚠️'],
  ['no_entry', '⛔'],
  ['x', '❌'],
  ['white_check_mark', '✅'],
  ['heavy_check_mark', '✔️'],
  ['question', '❓'],
  ['exclamation', '❗'],
  ['information_source', 'ℹ️'],
  ['100', '💯'],
  ['arrow_right', '➡️'],
  ['arrow_left', '⬅️'],
  ['arrow_up', '⬆️'],
  ['arrow_down', '⬇️'],
  ['recycle', '♻️'],
  ['white_flag', '🏳️'],
  ['checkered_flag', '🏁'],
  ['triangular_flag_on_post', '🚩'],
  ['speech_balloon', '💬'],
  ['thought_balloon', '💭'],
  ['zzz', '💤'],
];

/** Emoji for a `:query`, shortcode prefix matches first. */
export function filterEmoji(query: string, limit = 8): Array<readonly [string, string]> {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const prefix = RICH_MARKDOWN_EMOJI.filter(([code]) => code.startsWith(needle));
  const rest = RICH_MARKDOWN_EMOJI.filter(([code]) => !code.startsWith(needle) && code.includes(needle));
  return [...prefix, ...rest].slice(0, limit);
}

/** Markdown-looking plain text: block syntax at a line start or inline
 *  emphasis/links/code that a paste should turn into rich content. */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^(?:#{1,6}\s|\s*(?:[-*+]|\d+[.)])\s|\s*>\s?|```|~~~|\|.*\|\s*$|\s*[-*_]{3,}\s*$)/m.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|~~[^~\n]+~~/.test(text)
  );
}
