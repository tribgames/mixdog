//! The REPL's markdown renderer (`src/ui/markdown.mjs`): a minimal, line-oriented post-render of a complete markdown
//! text. The REPL streams raw tokens live, then on turn end clears the streamed block and prints this rendered form. It
//! does not use the lexer of the TUI: headings (ATX and setext), fenced code with a label and diff colouring, GFM
//! tables, block quotes, bullet, task and numbered items, rules, inline code, bold, italic, strike, escapes, links and
//! images as `text (url)`, reference links and footnotes.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{js_to_lowercase, js_trim, utf16_len};
use mixdog_tui_style::color::{Style, Styler, strip_ansi, visible_width};

use crate::heal::split_unescaped_pipes;
use crate::lexer::rules::Re;

// Default Mixdog dark markdown semantics (mirrors the `md*` keys of the TUI's `mixdogPalette`).
const HEADING1: Style = Style::Rgb(215.0, 119.0, 87.0);
const HEADING: Style = Style::Rgb(240.0, 198.0, 116.0);
const INLINE_CODE: Style = Style::Rgb(138.0, 190.0, 183.0);
const LINK: Style = Style::Rgb(47.0, 127.0, 255.0);
const CODE_BLOCK: Style = Style::Rgb(181.0, 189.0, 104.0);
const FENCE_LABEL: Style = Style::Rgb(138.0, 190.0, 183.0);
const LIST_BULLET: Style = Style::Rgb(138.0, 190.0, 183.0);
const RULE: Style = Style::Rgb(128.0, 128.0, 128.0);
const DIFF_ADD: Style = Style::Rgb(0.0, 170.0, 75.0);
const DIFF_DEL: Style = Style::Rgb(220.0, 70.0, 88.0);
const DIFF_HUNK: Style = Style::Rgb(204.0, 157.0, 44.0);

static FOOTNOTE_DEF: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}\[\^([^\]]+)\]:\s*(.*)$", ""));
static LINK_DEF: LazyLock<Re> = LazyLock::new(|| Re::new(r##"^ {0,3}\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+["'(].*)?\s*$"##, ""));
static SETEXT_H1: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}={2,}\s*$", ""));
static SETEXT_H2: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}-{2,}\s*$", ""));
static SETEXT_EXCLUDED: LazyLock<Re> = LazyLock::new(|| Re::new(r"^ {0,3}(#|>|[-*+] |\d+[.)] )", ""));
static TABLE_DELIM: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$", ""));
static FENCE_OPEN: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(\s*)(`{3,}|~{3,})(.*)$", ""));
static FENCE_CLOSE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(\s*)([`~]+)\s*$", ""));
static LEADING_PIPE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*\|", ""));
static TRAILING_PIPE: LazyLock<Re> = LazyLock::new(|| Re::new(r"\|\s*$", ""));
static HORIZONTAL_RULE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*([-*_])(\s*\1){2,}\s*$", ""));
static ATX_HEADING: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(#{1,6})\s+(.*?)\s*#*\s*$", ""));
static BLOCKQUOTE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(\s*>+)\s?(.*)$", ""));
static BULLET: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(\s*)([-*+])\s+(.*)$", ""));
static TASK_ITEM: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\[([ xX])\]\s+(.*)$", ""));
static NUMBERED: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(\s*)(\d+)([.)])\s+(.*)$", ""));
static DIFF_FENCE_TAG: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(diff|patch|udiff)$", ""));

static ESCAPE: LazyLock<Re> = LazyLock::new(|| Re::new(r"\\([\\`*_{}[\]()#+\-.!~>|])", ""));
static CODE_SPAN: LazyLock<Re> = LazyLock::new(|| Re::new(r"`([^`]+)`", ""));
static IMAGE: LazyLock<Re> = LazyLock::new(|| Re::new(r##"!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)"##, ""));
static LINK_TEXT: LazyLock<Re> = LazyLock::new(|| Re::new(r##"\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)"##, ""));
static FOOTNOTE_REF: LazyLock<Re> = LazyLock::new(|| Re::new(r"\[\^([^\]]+)\]", ""));
static REFERENCE_FULL: LazyLock<Re> = LazyLock::new(|| Re::new(r"\[([^\]]+)\]\[([^\]]*)\]", ""));
static REFERENCE_SHORT: LazyLock<Re> = LazyLock::new(|| Re::new(r"\[([^\]]+)\]", ""));
static BOLD_STARS: LazyLock<Re> = LazyLock::new(|| Re::new(r"\*\*([^*]+)\*\*", ""));
static BOLD_UNDERSCORES: LazyLock<Re> = LazyLock::new(|| Re::new(r"__([^_]+)__", ""));
static STRIKE: LazyLock<Re> = LazyLock::new(|| Re::new(r"~~([^~]+)~~", ""));
static ITALIC_STAR: LazyLock<Re> = LazyLock::new(|| Re::new(r"(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)", ""));
static ITALIC_UNDERSCORE: LazyLock<Re> = LazyLock::new(|| Re::new(r"(^|[^_\w])_([^_\s][^_]*?)_(?!_)", ""));
static CODE_PLACEHOLDER: LazyLock<Re> = LazyLock::new(|| Re::new(r"\u0000C(\d+)\u0000", ""));
static ESCAPE_PLACEHOLDER: LazyLock<Re> = LazyLock::new(|| Re::new(r"\u0000E(\d+)\u0000", ""));

/// The link references and footnotes pulled out of the body.
struct Definitions {
    links: HashMap<String, String>,
    footnotes: Vec<(String, String)>,
}

/// The inline renderer's parked spans: code spans and backslash escapes are replaced by placeholders while the
/// emphasis passes run, and put back at the end.
#[derive(Default)]
struct Parked {
    code_spans: Vec<String>,
    escapes: Vec<String>,
}

/// `clampWidth(w)`: a width of 20 to 120 columns is kept, anything else is 80.
fn clamp_width(width: usize) -> usize {
    if width >= 20 { width.min(120) } else { 80 }
}

/// `extractDefinitions(rawLines)`: the body lines without their link-reference and footnote definitions. Fenced blocks
/// are skipped: a definition-shaped line inside code is code.
fn extract_definitions(raw_lines: &[&str]) -> (Vec<String>, Definitions) {
    let mut links = HashMap::new();
    let mut footnotes = Vec::new();
    let mut lines = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in raw_lines {
        if let Some(open) = FENCE_OPEN.exec(line) {
            let marks = open.get(2).unwrap_or("");
            let marker = marks.chars().next().unwrap_or('`');
            match fence {
                None => fence = Some((marker, marks.len())),
                Some((current, length)) => {
                    if marker == current && marks.len() >= length {
                        fence = None;
                    }
                }
            }
            lines.push((*line).to_owned());
            continue;
        }
        if fence.is_none() {
            if let Some(footnote) = FOOTNOTE_DEF.exec(line) {
                footnotes.push((footnote.get(1).unwrap_or("").to_owned(), footnote.get(2).unwrap_or("").to_owned()));
                continue;
            }
            if let Some(definition) = LINK_DEF.exec(line) {
                let tag = js_to_lowercase(js_trim(definition.get(1).unwrap_or("")));
                links.insert(tag, definition.get(2).unwrap_or("").to_owned());
                continue;
            }
        }
        lines.push((*line).to_owned());
    }
    (lines, Definitions { links, footnotes })
}

/// `tableCells(row)`: the raw cell sources of one GFM table row.
fn table_cells(row: &str) -> Vec<String> {
    let after_lead = LEADING_PIPE.exec(row).map_or(row, |lead| &row[lead.end()..]);
    let body = TRAILING_PIPE.exec(after_lead).map_or(after_lead, |trail| &after_lead[..trail.start()]);
    split_unescaped_pipes(body).into_iter().map(|cell| js_trim(cell).to_owned()).collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Align {
    Left,
    Center,
    Right,
}

fn table_alignments(delimiter_row: &str) -> Vec<Align> {
    table_cells(delimiter_row)
        .iter()
        .map(|cell| match (cell.starts_with(':'), cell.ends_with(':')) {
            (true, true) => Align::Center,
            (_, true) => Align::Right,
            _ => Align::Left,
        })
        .collect()
}

fn pad_cell(text: &str, target: usize, align: Align) -> String {
    let padding = target.saturating_sub(visible_width(text));
    match align {
        Align::Right => format!("{}{text}", " ".repeat(padding)),
        Align::Center => {
            let left = padding / 2;
            format!("{}{text}{}", " ".repeat(left), " ".repeat(padding - left))
        }
        Align::Left => format!("{text}{}", " ".repeat(padding)),
    }
}

/// `padVisible(text, targetWidth)`.
fn pad_visible(text: &str, target: usize) -> String {
    let width = visible_width(text);
    if width >= target { text.to_owned() } else { format!("{text}{}", " ".repeat(target - width)) }
}

/// `isDiffFence(lang, lines)`: a diff-like language tag, or a hunk header and a changed line.
fn is_diff_fence(lang: &str, lines: &[&str]) -> bool {
    if DIFF_FENCE_TAG.test(&js_to_lowercase(js_trim(lang))) {
        return true;
    }
    let mut hunk = false;
    let mut delta = false;
    for line in lines {
        if line.starts_with("@@") {
            hunk = true;
        }
        if (line.starts_with('+') && !line.starts_with("+++")) || (line.starts_with('-') && !line.starts_with("---")) {
            delta = true;
        }
    }
    hunk && delta
}

struct Renderer {
    styler: Styler,
}

impl Renderer {
    fn bold(&self, text: &str) -> String {
        self.styler.paint(Style::Bold, text)
    }

    fn dim(&self, text: &str) -> String {
        self.styler.paint(Style::Dim, text)
    }

    fn italic(&self, text: &str) -> String {
        self.styler.paint(Style::Italic, text)
    }

    fn paint(&self, style: Style, text: &str) -> String {
        self.styler.paint(style, text)
    }

    fn compose(&self, styles: &[Style], text: &str) -> String {
        self.styler.compose(styles, text)
    }

    fn render(&self, src: &str, width: usize) -> String {
        let width = clamp_width(width);
        let normalised = src.replace("\r\n", "\n").replace('\r', "\n");
        let raw_lines: Vec<&str> = normalised.split('\n').collect();
        let (lines, defs) = extract_definitions(&raw_lines);
        let mut out: Vec<String> = Vec::new();

        let mut in_fence = false;
        let mut fence_lang = String::new();
        let mut fence_buf: Vec<&str> = Vec::new();
        let mut fence_marker = '`';
        let mut fence_marker_len = 0;

        let mut i = 0;
        while i < lines.len() {
            let line = lines[i].as_str();
            let fence_match = FENCE_OPEN.exec(line);

            if let (Some(open), false) = (&fence_match, in_fence) {
                in_fence = true;
                fence_lang = js_trim(open.get(3).unwrap_or("")).to_owned();
                let marks = open.get(2).unwrap_or("");
                fence_marker = marks.chars().next().unwrap_or('`');
                fence_marker_len = marks.len();
                fence_buf.clear();
                i += 1;
                continue;
            }
            if in_fence {
                let run = FENCE_CLOSE.exec(line).and_then(|close| close.get(2)).unwrap_or("");
                if run.len() >= fence_marker_len && run.chars().all(|c| c == fence_marker) {
                    out.push(self.render_code_block(&fence_buf, &fence_lang, width));
                    in_fence = false;
                    fence_lang.clear();
                    fence_buf.clear();
                    fence_marker_len = 0;
                } else {
                    fence_buf.push(line);
                }
                i += 1;
                continue;
            }

            // GFM table: a pipe row immediately followed by an alignment row.
            if line.contains('|') && TABLE_DELIM.test(lines.get(i + 1).map_or("", String::as_str)) {
                let mut rows = vec![line];
                let mut cursor = i + 2;
                while cursor < lines.len() && lines[cursor].contains('|') && !js_trim(&lines[cursor]).is_empty() {
                    rows.push(lines[cursor].as_str());
                    cursor += 1;
                }
                out.push(self.render_table(&rows, &lines[i + 1], width, &defs));
                i = cursor;
                continue;
            }

            // Setext heading: the underline belongs to the line above it, so the pair is rewritten into the ATX form the
            // line renderer already handles.
            let next = lines.get(i + 1).map_or("", String::as_str);
            let setext = if SETEXT_H1.test(next) {
                "#"
            } else if SETEXT_H2.test(next) {
                "##"
            } else {
                ""
            };
            if !setext.is_empty() && !js_trim(line).is_empty() && !SETEXT_EXCLUDED.test(line) {
                out.push(self.render_line(&format!("{setext} {}", js_trim(line)), width, &defs));
                i += 2;
                continue;
            }

            out.push(self.render_line(line, width, &defs));
            i += 1;
        }

        // Unterminated fence: render whatever was collected so nothing is lost.
        if in_fence {
            out.push(self.render_code_block(&fence_buf, &fence_lang, width));
        }

        // Pulling definition lines out of the body leaves their blank neighbours behind; the block must still end where
        // the prose does.
        while out.last().is_some_and(|last| js_trim(&strip_ansi(last)).is_empty()) {
            out.pop();
        }

        // Footnote texts are body prose: dropping the definitions with the reference plumbing deleted content the
        // author wrote.
        if !defs.footnotes.is_empty() {
            out.push(String::new());
            for (tag, text) in &defs.footnotes {
                out.push(format!("{} {}", self.dim(&format!("[{tag}]")), self.render_inline(text, &RefCell::default(), Some(&defs))));
            }
        }

        out.join("\n")
    }

    /// Renders a GFM table as an aligned, dim-ruled block (header row in bold); too wide to align, one "header: value"
    /// block per row.
    fn render_table(&self, rows: &[&str], delimiter_row: &str, width: usize, defs: &Definitions) -> String {
        let align = table_alignments(delimiter_row);
        let body: Vec<Vec<String>> = rows
            .iter()
            .enumerate()
            .map(|(row_index, row)| {
                table_cells(row)
                    .iter()
                    .map(|cell| {
                        let rendered = self.render_inline(cell, &RefCell::default(), Some(defs));
                        if row_index == 0 { self.bold(&rendered) } else { rendered }
                    })
                    .collect()
            })
            .collect();
        let columns = body.iter().map(Vec::len).max().unwrap_or(0);
        let widths: Vec<usize> = (0..columns)
            .map(|column| body.iter().map(|cells| cells.get(column).map_or(0, |cell| visible_width(cell))).max().unwrap_or(0))
            .collect();
        let total: usize = widths.iter().map(|value| value + 3).sum();
        let empty: Vec<String> = Vec::new();
        if total > width {
            // Too wide to align: one "header: value" block per row.
            let headers = body.first().unwrap_or(&empty);
            return body[1..]
                .iter()
                .map(|cells| {
                    cells
                        .iter()
                        .enumerate()
                        .map(|(column, cell)| {
                            let label = headers.get(column).map(|header| js_trim(&strip_ansi(header)).to_owned()).unwrap_or_default();
                            let label = if label.is_empty() { "-".to_owned() } else { label };
                            format!("{} {cell}", self.dim(&format!("{label}:")))
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .collect::<Vec<_>>()
                .join("\n\n");
        }
        let separator = self.dim(" \u{2502} ");
        let line = |cells: &[String]| -> String {
            cells
                .iter()
                .enumerate()
                .map(|(column, cell)| pad_cell(cell, widths[column], align.get(column).copied().unwrap_or(Align::Left)))
                .collect::<Vec<_>>()
                .join(separator.as_str())
        };
        let rule = self.dim(&widths.iter().map(|value| "\u{2500}".repeat(*value)).collect::<Vec<_>>().join("\u{2500}\u{253c}\u{2500}"));
        let mut rendered = vec![line(body.first().unwrap_or(&empty)), rule];
        rendered.extend(body[1..].iter().map(|cells| line(cells)));
        rendered.join("\n")
    }

    // --- Block level ---------------------------------------------------------------------------------------------

    fn render_line(&self, line: &str, width: usize, defs: &Definitions) -> String {
        // Horizontal rule.
        if HORIZONTAL_RULE.test(line) {
            return self.dim(&self.paint(RULE, &"\u{2500}".repeat(width.min(60))));
        }

        // ATX heading.
        if let Some(heading) = ATX_HEADING.exec(line) {
            let level = heading.get(1).unwrap_or("").len();
            let text = self.render_inline(heading.get(2).unwrap_or(""), &RefCell::default(), Some(defs));
            return match level {
                1 => format!("\n{}", self.compose(&[Style::Bold, HEADING1], &format!("\u{258c} {text}"))),
                2 => format!("\n{}", self.compose(&[Style::Bold, HEADING], &text)),
                3 => self.compose(&[Style::Bold, HEADING], &text),
                _ => self.compose(&[Style::Bold, Style::Dim], &text),
            };
        }

        // Block quote (possibly nested).
        if let Some(quote) = BLOCKQUOTE.exec(line) {
            return format!(
                "{}{}",
                self.dim("\u{2502} "),
                self.italic(&self.render_inline(quote.get(2).unwrap_or(""), &RefCell::default(), Some(defs)))
            );
        }

        // Bullet list.
        if let Some(bullet) = BULLET.exec(line) {
            let indent = bullet.get(1).unwrap_or("").replace('\t', "  ");
            let rest = bullet.get(3).unwrap_or("");
            // GFM task item: the box state is the item's meaning, so it replaces the bullet instead of being rendered as
            // literal "[ ]" prose.
            if let Some(task) = TASK_ITEM.exec(rest) {
                let mark = if task.get(1) == Some(" ") { "[ ]" } else { "[x]" };
                return format!(
                    "{indent}{} {}",
                    self.paint(LIST_BULLET, mark),
                    self.render_inline(task.get(2).unwrap_or(""), &RefCell::default(), Some(defs))
                );
            }
            return format!("{indent}{} {}", self.paint(LIST_BULLET, "\u{2022}"), self.render_inline(rest, &RefCell::default(), Some(defs)));
        }

        // Numbered list.
        if let Some(numbered) = NUMBERED.exec(line) {
            let indent = numbered.get(1).unwrap_or("").replace('\t', "  ");
            let marker = format!("{}.", numbered.get(2).unwrap_or(""));
            return format!(
                "{indent}{} {}",
                self.paint(LIST_BULLET, &marker),
                self.render_inline(numbered.get(4).unwrap_or(""), &RefCell::default(), Some(defs))
            );
        }

        // Plain paragraph line.
        self.render_inline(line, &RefCell::default(), Some(defs))
    }

    fn render_code_block(&self, buffered: &[&str], lang: &str, width: usize) -> String {
        let inner: Vec<&str> = if buffered.is_empty() { vec![""] } else { buffered.to_vec() };
        let is_diff = is_diff_fence(lang, &inner);
        let longest = inner.iter().map(|line| utf16_len(line)).max().unwrap_or(0);
        let content_width = 20.max(width.min(longest + 2));
        let label_plain = if lang.is_empty() { String::new() } else { format!(" {lang} ") };
        let label_styled = if label_plain.is_empty() { String::new() } else { self.paint(FENCE_LABEL, &label_plain) };
        let rule_len = content_width.saturating_sub(visible_width(&label_plain));
        let top = format!("{}{label_styled}{}", self.dim("\u{250c}"), self.dim(&format!("{}\u{2510}", "\u{2500}".repeat(rule_len))));
        let bottom = self.dim(&format!("\u{2514}{}\u{2518}", "\u{2500}".repeat(content_width)));
        let pad_target = content_width.saturating_sub(1);
        let mut rendered = vec![top];
        for line in &inner {
            let text = self.color_fence_line(line, is_diff);
            rendered.push(format!("{}{}{}", self.dim("\u{2502} "), pad_visible(&text, pad_target), self.dim("\u{2502}")));
        }
        rendered.push(bottom);
        rendered.join("\n")
    }

    fn color_fence_line(&self, line: &str, is_diff: bool) -> String {
        if !self.styler.enabled() {
            return line.to_owned();
        }
        if !is_diff {
            return self.paint(CODE_BLOCK, line);
        }
        if line.starts_with("@@") || line.starts_with("+++") || line.starts_with("---") {
            return self.paint(DIFF_HUNK, line);
        }
        if line.starts_with('+') {
            return self.paint(DIFF_ADD, line);
        }
        if line.starts_with('-') {
            return self.paint(DIFF_DEL, line);
        }
        self.paint(CODE_BLOCK, line)
    }

    // --- Inline ----------------------------------------------------------------------------------------------------

    /// Renders inline markdown spans. Order matters: escapes and code spans are parked first (their contents are
    /// literal), then the emphasis and link transforms run on the rest.
    fn render_inline(&self, text: &str, parked: &RefCell<Parked>, defs: Option<&Definitions>) -> String {
        // A backslash escape is a literal character, not markup. Park it before any emphasis pass: without this,
        // `a\*x\*b` lost both the backslash and the star it was protecting.
        let mut s = ESCAPE.replace_all(text, |found| {
            let mut parked = parked.borrow_mut();
            let token = format!("\u{0}E{}\u{0}", parked.escapes.len());
            parked.escapes.push(found.get(1).unwrap_or("").to_owned());
            token
        });

        // Protect inline code spans from further formatting.
        s = CODE_SPAN.replace_all(&s, |found| {
            let mut parked = parked.borrow_mut();
            let token = format!("\u{0}C{}\u{0}", parked.code_spans.len());
            parked.code_spans.push(found.get(1).unwrap_or("").to_owned());
            token
        });

        // Images: ![alt](url) -> alt (url). Before links, otherwise the leading "!" survived as literal prose in front
        // of the label.
        s = IMAGE.replace_all(&s, |found| {
            let alt = found.get(1).unwrap_or("");
            let url = found.get(2).unwrap_or("");
            let label = if js_trim(alt).is_empty() {
                String::new()
            } else {
                self.compose(&[Style::Underline, LINK], &self.render_inline(alt, parked, defs))
            };
            if label.is_empty() { self.dim(url) } else { format!("{label} {}", self.dim(&format!("({url})"))) }
        });

        // Links: [text](url) -> text (url)
        s = LINK_TEXT.replace_all(&s, |found| {
            let label = self.compose(&[Style::Underline, LINK], &self.render_inline(found.get(1).unwrap_or(""), parked, defs));
            format!("{label} {}", self.dim(&format!("({})", found.get(2).unwrap_or(""))))
        });

        // Footnote reference: the definition text is printed as an apparatus block.
        s = FOOTNOTE_REF.replace_all(&s, |found| self.dim(&format!("[{}]", found.get(1).unwrap_or(""))));

        // Reference links: [text][tag], [tag][] and the shortcut [tag].
        if let Some(definitions) = defs.filter(|definitions| !definitions.links.is_empty()) {
            let reference = |label: &str, tag: &str| -> Option<String> {
                let key = js_to_lowercase(js_trim(if tag.is_empty() { label } else { tag }));
                let url = definitions.links.get(&key)?;
                Some(format!(
                    "{} {}",
                    self.compose(&[Style::Underline, LINK], &self.render_inline(label, parked, defs)),
                    self.dim(&format!("({url})"))
                ))
            };
            s = REFERENCE_FULL.replace_all(&s, |found| {
                reference(found.get(1).unwrap_or(""), found.get(2).unwrap_or("")).unwrap_or_else(|| found.whole().to_owned())
            });
            s = REFERENCE_SHORT.replace_all(&s, |found| {
                let label = found.get(1).unwrap_or("");
                reference(label, label).unwrap_or_else(|| found.whole().to_owned())
            });
        }

        // Bold: **x** or __x__
        s = BOLD_STARS.replace_all(&s, |found| self.bold(found.get(1).unwrap_or("")));
        s = BOLD_UNDERSCORES.replace_all(&s, |found| self.bold(found.get(1).unwrap_or("")));

        // Strikethrough: ~~x~~
        s = STRIKE.replace_all(&s, |found| self.paint(Style::Strike, found.get(1).unwrap_or("")));

        // Italic: *x* or _x_ (avoid matching list bullets / already-consumed bold).
        s = ITALIC_STAR.replace_all(&s, |found| format!("{}{}", found.get(1).unwrap_or(""), self.italic(found.get(2).unwrap_or(""))));
        s = ITALIC_UNDERSCORE
            .replace_all(&s, |found| format!("{}{}", found.get(1).unwrap_or(""), self.italic(found.get(2).unwrap_or(""))));

        // Restore code spans, styled.
        s = CODE_PLACEHOLDER.replace_all(&s, |found| {
            let index: usize = found.get(1).and_then(|digits| digits.parse().ok()).unwrap_or(usize::MAX);
            let parked = parked.borrow();
            let code = parked.code_spans.get(index).map_or("", String::as_str);
            if self.styler.enabled() { self.paint(INLINE_CODE, code) } else { format!("`{code}`") }
        });

        // Restore escaped characters as their literal selves.
        ESCAPE_PLACEHOLDER.replace_all(&s, |found| {
            let index: usize = found.get(1).and_then(|digits| digits.parse().ok()).unwrap_or(usize::MAX);
            parked.borrow().escapes.get(index).cloned().unwrap_or_default()
        })
    }
}

/// `renderMarkdown(src, { width })`: a markdown string as terminal-styled text, under the colour decision of this
/// process (`NO_COLOR`, `FORCE_COLOR`, whether stdout is a terminal). A width of 20 to 120 columns is kept, anything
/// else is 80.
pub fn render_repl_markdown(text: &str, width: usize) -> String {
    render_repl_markdown_with(text, width, Styler::process())
}

/// [`render_repl_markdown`] under a given colour decision.
pub fn render_repl_markdown_with(text: &str, width: usize, styler: Styler) -> String {
    Renderer { styler }.render(text, width)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFF: Styler = Styler::new(false, true);
    const ON: Styler = Styler::new(true, true);

    fn plain(text: &str, width: usize) -> String {
        render_repl_markdown_with(text, width, OFF)
    }

    #[test]
    fn wide_tables_strip_header_styles_and_label_empty_or_missing_headers_with_a_dash() {
        let source = "| \u{1b}[31mName\u{1b}[0m | |\n| --- | --- |\n| abcdefghijklmnopqrstuv | tail | extra |";
        assert_eq!(plain(source, 20), "Name: abcdefghijklmnopqrstuv\n-: tail\n-: extra");
    }

    #[test]
    fn narrow_tables_are_aligned_and_ruled() {
        let source = "| a | bb |\n|:--|--:|\n| ccc | d |";
        assert_eq!(plain(source, 80), "a   \u{2502} bb\n\u{2500}\u{2500}\u{2500}\u{2500}\u{253c}\u{2500}\u{2500}\u{2500}\nccc \u{2502}  d");
    }

    #[test]
    fn block_lines_render_as_the_repl_draws_them() {
        assert_eq!(plain("# One\n## Two\n### Three\n#### Four", 80), "\n\u{258c} One\n\nTwo\nThree\nFour");
        assert_eq!(plain("- a\n  * b\n1. x\n2) y\n- [ ] t\n- [X] u", 80), "\u{2022} a\n  \u{2022} b\n1. x\n2. y\n[ ] t\n[x] u");
        assert_eq!(plain("> quote **b**", 80), "\u{2502} quote b");
        assert_eq!(plain("---", 80), "\u{2500}".repeat(60));
        assert_eq!(plain("Title\n=====\ntext", 80), "\n\u{258c} Title\ntext");
    }

    #[test]
    fn inline_markup_keeps_escapes_and_code_literal() {
        assert_eq!(plain("a\\*x\\*b `c *d*` **e** _f_ ~~g~~", 80), "a*x*b `c *d*` e f g");
        assert_eq!(plain("[t](http://x) ![alt](http://y/i.png)", 80), "t (http://x) alt (http://y/i.png)");
        assert_eq!(plain("see [r][ref] and [ref]\n\n[ref]: http://z", 80), "see r (http://z) and ref (http://z)");
        assert_eq!(plain("body[^1]\n\n[^1]: the note", 80), "body[1]\n\n[1] the note");
    }

    #[test]
    fn fenced_code_is_boxed_with_its_label_and_unterminated_fences_keep_their_lines() {
        let boxed = plain("```rs\nlet a = 1;\n```", 80);
        let bar = |count: usize| "\u{2500}".repeat(count);
        let expected = format!(
            "\u{250c} rs {}\u{2510}\n\u{2502} let a = 1;{}\u{2502}\n\u{2514}{}\u{2518}",
            bar(16),
            " ".repeat(9),
            bar(20)
        );
        assert_eq!(boxed, expected);
        assert!(plain("~~~\nopen", 80).contains("open"));
        assert!(plain("```\n```", 80).starts_with('\u{250c}'));
    }

    #[test]
    fn colour_wraps_the_styled_runs_and_diff_fences_colour_their_lines() {
        let rendered = render_repl_markdown_with("**b** `c`", 80, ON);
        assert_eq!(rendered, "\u{1b}[1mb\u{1b}[0m \u{1b}[38;2;138;190;183mc\u{1b}[0m");
        let diff = render_repl_markdown_with("```diff\n+a\n-b\n@@ x\n```", 80, ON);
        assert!(diff.contains("\u{1b}[38;2;0;170;75m+a"));
        assert!(diff.contains("\u{1b}[38;2;220;70;88m-b"));
        assert!(diff.contains("\u{1b}[38;2;204;157;44m@@ x"));
    }

    #[test]
    fn the_width_is_clamped_and_blank_ends_are_dropped() {
        assert_eq!(plain("---", 10), "\u{2500}".repeat(60));
        assert_eq!(plain("---", 500), "\u{2500}".repeat(60));
        assert_eq!(plain("text\n\n\n", 80), "text");
        assert_eq!(plain("", 80), "");
    }
}
