//! marked's block tokenizers and `Lexer.blockTokens`.

use mixdog_js::{js_to_lowercase, js_trim, js_trim_end};

use super::rules::{Re, item_rule, list_lookahead};
use super::token::{Align, ListStart, TableCell, Token, TokenKind};
use super::{Lexer, advance, first_non_space, prefix, rtrim_char, skip_chars};

lazy_re!(INDENT_STRIP, r"^(?: {1,4}| {0,3}\t)", "gm");
lazy_re!(INDENT_TO_CODE, r"^(\s+)(?:```)");
lazy_re!(LEADING_SPACE, r"^\s+");
lazy_re!(BLOCKQUOTE_LINE, r"^ {0,3}>");
lazy_re!(SETEXT_GUARD, r"\n {0,3}((?:=+|-+) *)(?=\n|$)", "g");
lazy_re!(BLOCKQUOTE_MARK, r"^ {0,3}>[ \t]?", "gm");
lazy_re!(TRAILING_BLANK, r"\n[ \t]*\n[ \t]*$");
lazy_re!(TASK_START, r"^\[[ xX]\] ");
lazy_re!(TASK_STRIP, r"^\[[ xX]\] +");
lazy_re!(BLANK_LINE, r"^[ \t]*$");
lazy_re!(TWO_LINE_BREAKS, r"\n.*\n");
lazy_re!(WHITESPACE_RUN, r"\s+", "g");
lazy_re!(ANGLE_HREF, r"^<(.*)>$");
lazy_re!(DELIMITER_ENDS, r"^\||\| *$", "g");
lazy_re!(NOT_SETEXT, r"[:|]");
lazy_re!(ALIGN_RIGHT, r"^ *-+: *$");
lazy_re!(ALIGN_CENTER, r"^ *:-+: *$");
lazy_re!(ALIGN_LEFT, r"^ *:-+ *$");
lazy_re!(CELL_TAIL_BLANK, r"\n[ \t]*$");

/// `text.replace(/\\(punctuation)/gu, '$1')`: the backslash of an escaped punctuation mark removed.
pub(super) fn unescape_punctuation(re: &Re, text: &str) -> String {
    re.replace_all(text, |caps| caps.get(1).unwrap_or("").to_owned())
}

/// marked's `indentCodeCompensation(raw, text)`: the indentation of a fence taken off the lines of its body.
fn indent_code_compensation(raw: &str, text: &str) -> String {
    let Some(found) = INDENT_TO_CODE.exec(raw) else {
        return text.to_owned();
    };
    let indent = found.get(1).unwrap_or("").chars().count();
    let lines: Vec<&str> = text
        .split('\n')
        .map(|node| match LEADING_SPACE.exec(node) {
            Some(lead) if lead.whole().chars().count() >= indent => skip_chars(node, indent),
            _ => node,
        })
        .collect();
    lines.join("\n")
}

/// marked's `splitCells(tableRow, count)`: the cells of a row, an escaped pipe kept in its cell.
fn split_cells(table_row: &str, count: Option<usize>) -> Vec<String> {
    let bytes = table_row.as_bytes();
    let mut row = String::with_capacity(table_row.len() + 8);
    let mut last = 0;
    for (at, byte) in bytes.iter().enumerate() {
        if *byte != b'|' {
            continue;
        }
        let backslashes = bytes[..at].iter().rev().take_while(|b| **b == b'\\').count();
        row.push_str(&table_row[last..at]);
        if backslashes % 2 == 1 {
            row.push('|');
        } else {
            row.push_str(" |");
        }
        last = at + 1;
    }
    row.push_str(&table_row[last..]);
    let mut cells: Vec<String> = row.split(" |").map(str::to_owned).collect();
    if cells.first().is_some_and(|cell| js_trim(cell).is_empty()) {
        cells.remove(0);
    }
    if cells.last().is_some_and(|cell| js_trim(cell).is_empty()) {
        cells.pop();
    }
    if let Some(count) = count {
        if cells.len() > count {
            cells.truncate(count);
        } else {
            while cells.len() < count {
                cells.push(String::new());
            }
        }
    }
    cells.iter().map(|cell| js_trim(cell).replace("\\|", "|")).collect()
}

/// A reference definition as the tokenizer reads it (it never becomes a token of the result).
pub(super) struct Definition {
    pub(super) tag: String,
    pub(super) raw: String,
    pub(super) href: String,
    pub(super) title: Option<String>,
}

fn queued_text(kind: TokenKind, raw: &str, text: &str, id: usize) -> Token {
    let mut token = Token::with_text(kind, raw, text);
    token.tokens = Some(Vec::new());
    token.queued = Some(id);
    token
}

impl Lexer {
    /// `Lexer.blockTokens(src, tokens, lastParagraphClipped)`.
    pub(super) fn block_tokens(&mut self, src: &str, tokens: &mut Vec<Token>, mut last_paragraph_clipped: bool) {
        let mut src = src;
        while !src.is_empty() {
            // newline
            if let Some(token) = self.space(src) {
                src = advance(src, token.raw.len());
                if token.raw.len() == 1 && !tokens.is_empty() {
                    // a single \n terminates the last line: it goes there so no paragraph is cut
                    if let Some(last) = tokens.last_mut() {
                        last.raw.push('\n');
                    }
                } else {
                    tokens.push(token);
                }
                continue;
            }
            // code
            if let Some(token) = self.code(src) {
                src = advance(src, token.raw.len());
                // An indented code block cannot interrupt a paragraph.
                let continued = match tokens.last_mut() {
                    Some(last) if matches!(last.kind, TokenKind::Paragraph | TokenKind::Text) => {
                        last.raw.push('\n');
                        last.raw.push_str(&token.raw);
                        let text = last.text.get_or_insert_with(String::new);
                        text.push('\n');
                        text.push_str(token.text_str());
                        Some(text.clone())
                    }
                    _ => None,
                };
                match continued {
                    Some(text) => self.requeue_last(&text),
                    None => tokens.push(token),
                }
                continue;
            }
            // fences
            if let Some(token) = self.fences(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // heading
            if let Some(token) = self.heading(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // hr
            if let Some(token) = self.hr(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // blockquote
            if let Some(token) = self.blockquote(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // list
            if let Some(token) = self.list(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // html
            if let Some(token) = self.html(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // def
            if let Some(def) = self.def(src) {
                src = advance(src, def.raw.len());
                let continued = match tokens.last_mut() {
                    Some(last) if matches!(last.kind, TokenKind::Paragraph | TokenKind::Text) => {
                        last.raw.push('\n');
                        last.raw.push_str(&def.raw);
                        let text = last.text.get_or_insert_with(String::new);
                        text.push('\n');
                        text.push_str(&def.raw);
                        Some(text.clone())
                    }
                    _ => None,
                };
                match continued {
                    Some(text) => self.requeue_last(&text),
                    None => {
                        self.links.entry(def.tag).or_insert(super::token::Link { href: def.href, title: def.title });
                    }
                }
                continue;
            }
            // table (gfm)
            if let Some(token) = self.table(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // lheading
            if let Some(token) = self.lheading(src) {
                src = advance(src, token.raw.len());
                tokens.push(token);
                continue;
            }
            // top-level paragraph
            let paragraph = if self.state.top { self.paragraph(src) } else { None };
            if let Some(token) = paragraph {
                let merge = last_paragraph_clipped && tokens.last().is_some_and(|last| last.kind == TokenKind::Paragraph);
                src = advance(src, token.raw.len());
                if merge {
                    let merged = tokens.last_mut().map(|last| {
                        last.raw.push('\n');
                        last.raw.push_str(&token.raw);
                        let text = last.text.get_or_insert_with(String::new);
                        text.push('\n');
                        text.push_str(token.text_str());
                        text.clone()
                    });
                    self.queue.pop();
                    if let Some(text) = merged {
                        self.requeue_last(&text);
                    }
                } else {
                    tokens.push(token);
                }
                last_paragraph_clipped = false;
                continue;
            }
            // text
            if let Some(token) = self.text(src) {
                src = advance(src, token.raw.len());
                let merge = tokens.last().is_some_and(|last| last.kind == TokenKind::Text);
                if merge {
                    let merged = tokens.last_mut().map(|last| {
                        last.raw.push('\n');
                        last.raw.push_str(&token.raw);
                        let text = last.text.get_or_insert_with(String::new);
                        text.push('\n');
                        text.push_str(token.text_str());
                        text.clone()
                    });
                    self.queue.pop();
                    if let Some(text) = merged {
                        self.requeue_last(&text);
                    }
                } else {
                    tokens.push(token);
                }
                continue;
            }
            // marked throws here ("Infinite loop on byte"); the text rule matches every line, so this is not reached.
            break;
        }
        self.state.top = true;
    }

    fn space(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.newline.exec(src)?;
        (!cap.whole().is_empty()).then(|| Token::new(TokenKind::Space, cap.whole()))
    }

    fn code(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.code.exec(src)?;
        let text = INDENT_STRIP.replace_all(cap.whole(), |_| String::new());
        let mut token = Token::with_text(TokenKind::Code, cap.whole(), rtrim_char(&text, '\n'));
        token.code_block_style = Some("indented");
        Some(token)
    }

    fn fences(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.fences.exec(src)?;
        let raw = cap.whole();
        let text = indent_code_compensation(raw, cap.get(3).unwrap_or(""));
        let lang = match cap.get(2) {
            Some(info) if !info.is_empty() => unescape_punctuation(&self.rules.inline.any_punctuation, js_trim(info)),
            Some(info) => info.to_owned(),
            None => String::new(),
        };
        let mut token = Token::with_text(TokenKind::Code, raw, text);
        token.lang = Some(lang);
        Some(token)
    }

    fn heading(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.heading.exec(src)?;
        let mut text = js_trim(cap.get(2).unwrap_or("")).to_owned();
        // remove trailing #s
        if text.ends_with('#') {
            let trimmed = rtrim_char(&text, '#');
            // CommonMark requires a space before the trailing #s
            if trimmed.is_empty() || trimmed.ends_with(' ') {
                let cut = js_trim(trimmed).to_owned();
                text = cut;
            }
        }
        let id = self.inline(&text);
        let mut token = queued_text(TokenKind::Heading, cap.whole(), &text, id);
        token.depth = Some(cap.get(1).map_or(0, |marks| u32::try_from(marks.len()).unwrap_or(6)));
        Some(token)
    }

    fn hr(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.hr.exec(src)?;
        Some(Token::new(TokenKind::Hr, rtrim_char(cap.whole(), '\n')))
    }

    fn blockquote(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.blockquote.exec(src)?;
        let mut lines: Vec<String> = rtrim_char(cap.whole(), '\n').split('\n').map(str::to_owned).collect();
        let mut raw = String::new();
        let mut text = String::new();
        let mut tokens: Vec<Token> = Vec::new();
        while !lines.is_empty() {
            let mut in_blockquote = false;
            let mut taken = lines.len();
            let mut current_lines: Vec<&str> = Vec::new();
            // get lines up to a continuation
            for (index, line) in lines.iter().enumerate() {
                if BLOCKQUOTE_LINE.test(line) {
                    current_lines.push(line);
                    in_blockquote = true;
                } else if !in_blockquote {
                    current_lines.push(line);
                } else {
                    taken = index;
                    break;
                }
            }
            let current_raw = current_lines.join("\n");
            lines = lines.split_off(taken);
            // precede setext continuation with 4 spaces so it isn't a setext
            let guarded = SETEXT_GUARD.replace_all(&current_raw, |caps| format!("\n    {}", caps.get(1).unwrap_or("")));
            let current_text = BLOCKQUOTE_MARK.replace_all(&guarded, |_| String::new());
            raw = if raw.is_empty() { current_raw } else { format!("{raw}\n{current_raw}") };
            text = if text.is_empty() { current_text.clone() } else { format!("{text}\n{current_text}") };
            // parse blockquote lines as top level tokens, merging paragraphs if this is a continuation
            let top = self.state.top;
            self.state.top = true;
            self.block_tokens(&current_text, &mut tokens, true);
            self.state.top = top;
            // if there is no continuation then we are done
            if lines.is_empty() {
                break;
            }
            let last_kind = tokens.last().map(|last| last.kind);
            match last_kind {
                // blockquote continuation cannot be preceded by a code block
                Some(TokenKind::Code) => break,
                // include continuation in nested blockquote
                Some(TokenKind::Blockquote) => {
                    let (old_raw, old_text) = tokens.last().map(|last| (last.raw.clone(), last.text_str().to_owned())).unwrap_or_default();
                    let new_text = format!("{old_raw}\n{}", lines.join("\n"));
                    let Some(new_token) = self.blockquote(&new_text) else { break };
                    raw = format!("{}{}", prefix(&raw, raw.len().saturating_sub(old_raw.len())), new_token.raw);
                    text = format!("{}{}", prefix(&text, text.len().saturating_sub(old_text.len())), new_token.text_str());
                    if let Some(last) = tokens.last_mut() {
                        *last = new_token;
                    }
                    break;
                }
                // include continuation in nested list
                Some(TokenKind::List) => {
                    let old_raw = tokens.last().map(|last| last.raw.clone()).unwrap_or_default();
                    let new_text = format!("{old_raw}\n{}", lines.join("\n"));
                    let Some(new_token) = self.list(&new_text) else { break };
                    raw = format!("{}{}", prefix(&raw, raw.len().saturating_sub(old_raw.len())), new_token.raw);
                    text = format!("{}{}", prefix(&text, text.len().saturating_sub(old_raw.len())), new_token.raw);
                    lines = advance(&new_text, new_token.raw.len()).split('\n').map(str::to_owned).collect();
                    if let Some(last) = tokens.last_mut() {
                        *last = new_token;
                    }
                }
                _ => {}
            }
        }
        let mut token = Token::with_text(TokenKind::Blockquote, raw, text);
        token.tokens = Some(tokens);
        Some(token)
    }

    pub(super) fn list(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.list.exec(src)?;
        let bull = js_trim(cap.get(1).unwrap_or(""));
        let ordered = bull.chars().count() > 1;
        let mut list = Token::new(TokenKind::List, "");
        list.ordered = Some(ordered);
        list.start = Some(if ordered {
            ListStart::Number(prefix(bull, bull.len() - 1).parse().unwrap_or(0))
        } else {
            ListStart::None
        });
        let item_re = item_rule(bull);
        let mut src = src;
        let mut items: Vec<Token> = Vec::new();
        let mut list_raw = String::new();
        let mut loose = false;
        let mut ends_with_blank_line = false;
        // Check if current bullet point can start a new List Item
        while !src.is_empty() {
            let mut end_early = false;
            let Some(cap) = item_re.exec(src) else { break };
            // End list if bullet was actually HR
            if self.rules.block.hr.test(src) {
                break;
            }
            let mut raw = cap.whole().to_owned();
            let bullet = cap.get(1).unwrap_or("");
            let rest = cap.get(2).unwrap_or("");
            src = advance(src, raw.len());
            let first_line = rest.split('\n').next().unwrap_or("");
            let tabs = first_line.len() - first_line.trim_start_matches('\t').len();
            let mut line = format!("{}{}", " ".repeat(3 * tabs), &first_line[tabs..]);
            let next_line = src.split('\n').next().unwrap_or("");
            let mut blank_line = js_trim(&line).is_empty();
            let (indent, mut item_contents) = if blank_line {
                (bullet.len() + 1, String::new())
            } else {
                // Find first non-space char; indented code blocks (> 4 spaces) count as having only 1 indent
                let found = first_non_space(rest).unwrap_or(0);
                let found = if found > 4 { 1 } else { found };
                (found + bullet.len(), skip_chars(&line, found).to_owned())
            };
            // Items begin with at most one blank line
            if blank_line && BLANK_LINE.test(next_line) {
                raw.push_str(next_line);
                raw.push('\n');
                src = advance(src, next_line.len() + 1);
                end_early = true;
            }
            if !end_early {
                let look = list_lookahead(indent);
                // Check if following lines should be included in List Item
                while !src.is_empty() {
                    let raw_line = src.split('\n').next().unwrap_or("");
                    let next_line = raw_line;
                    // Re-align to follow commonmark nesting rules
                    let next_line_without_tabs = next_line.replace('\t', "    ");
                    // End list item if found code fences, a new heading, an html block, a new bullet or a rule
                    if look.fences_begin.test(next_line)
                        || look.heading_begin.test(next_line)
                        || look.html_begin.test(next_line)
                        || look.next_bullet.test(next_line)
                        || look.hr.test(next_line)
                    {
                        break;
                    }
                    if first_non_space(&next_line_without_tabs).is_some_and(|at| at >= indent) || js_trim(next_line).is_empty() {
                        // Dedent if possible
                        item_contents.push('\n');
                        item_contents.push_str(skip_chars(&next_line_without_tabs, indent));
                    } else {
                        // not enough indentation
                        if blank_line {
                            break;
                        }
                        // paragraph continuation unless last line was a different block level element
                        if first_non_space(&line.replace('\t', "    ")).is_some_and(|at| at >= 4) {
                            break; // indented code block
                        }
                        if look.fences_begin.test(&line) || look.heading_begin.test(&line) || look.hr.test(&line) {
                            break;
                        }
                        item_contents.push('\n');
                        item_contents.push_str(next_line);
                    }
                    if !blank_line && js_trim(next_line).is_empty() {
                        blank_line = true;
                    }
                    raw.push_str(raw_line);
                    raw.push('\n');
                    src = advance(src, raw_line.len() + 1);
                    line = skip_chars(&next_line_without_tabs, indent).to_owned();
                }
            }
            if !loose {
                // If the previous item ended with a blank line, the list is loose
                if ends_with_blank_line {
                    loose = true;
                } else if TRAILING_BLANK.test(&raw) {
                    ends_with_blank_line = true;
                }
            }
            // Check for task list items
            let mut task = false;
            let mut checked = None;
            let task_start = TASK_START.exec(&item_contents).map(|start| start.whole() != "[ ] ");
            if let Some(is_checked) = task_start {
                task = true;
                checked = Some(is_checked);
                let end = TASK_STRIP.exec(&item_contents).map(|strip| strip.end());
                if let Some(end) = end {
                    item_contents = item_contents[end..].to_owned();
                }
            }
            let mut item = Token::with_text(TokenKind::ListItem, raw.as_str(), item_contents);
            item.task = Some(task);
            item.checked = checked;
            item.loose = Some(false);
            item.tokens = Some(Vec::new());
            list_raw.push_str(&raw);
            items.push(item);
        }
        // Do not consume newlines at end of final item.
        let last = items.last_mut()?;
        last.raw = js_trim_end(&last.raw).to_owned();
        let trimmed_text = js_trim_end(last.text_str()).to_owned();
        last.text = Some(trimmed_text);
        list.raw = js_trim_end(&list_raw).to_owned();
        // Item child tokens handled here at end because we needed to have the final item to trim it first
        for item in &mut items {
            self.state.top = false;
            let item_text = item.text_str().to_owned();
            let mut children = Vec::new();
            self.block_tokens(&item_text, &mut children, false);
            if !loose {
                // Check if list should be loose
                loose = children.iter().filter(|child| child.kind == TokenKind::Space).any(|child| TWO_LINE_BREAKS.test(&child.raw));
            }
            item.tokens = Some(children);
        }
        // Set all items to loose if list is loose
        if loose {
            for item in &mut items {
                item.loose = Some(true);
            }
        }
        list.loose = Some(loose);
        list.items = Some(items);
        Some(list)
    }

    fn html(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.html.exec(src)?;
        let mut token = Token::with_text(TokenKind::Html, cap.whole(), cap.whole());
        token.block = Some(true);
        token.pre = Some(matches!(cap.get(1), Some("pre" | "script" | "style")));
        Some(token)
    }

    fn def(&mut self, src: &str) -> Option<Definition> {
        let cap = self.rules.block.def.exec(src)?;
        let tag = WHITESPACE_RUN.replace_all(&js_to_lowercase(cap.get(1).unwrap_or("")), |_| " ".to_owned());
        let href = match cap.get(2).filter(|href| !href.is_empty()) {
            Some(href) => {
                let inner = ANGLE_HREF.exec(href).and_then(|m| m.get(1)).unwrap_or(href);
                unescape_punctuation(&self.rules.inline.any_punctuation, inner)
            }
            None => String::new(),
        };
        let title = cap.get(3).map(|title| {
            let inner = super::trim_ends(title, 1);
            unescape_punctuation(&self.rules.inline.any_punctuation, inner)
        });
        Some(Definition { tag, raw: cap.whole().to_owned(), href, title })
    }

    fn table(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.table.exec(src)?;
        let delimiter = cap.get(2).unwrap_or("");
        // the delimiter row must have a pipe (|) or colon (:), otherwise it is a setext heading
        if !NOT_SETEXT.test(delimiter) {
            return None;
        }
        let headers = split_cells(cap.get(1).unwrap_or(""), None);
        let stripped = DELIMITER_ENDS.replace_all(delimiter, |_| String::new());
        let aligns: Vec<&str> = stripped.split('|').collect();
        let body = cap.get(3).unwrap_or("");
        let rows: Vec<String> = if js_trim(body).is_empty() {
            Vec::new()
        } else {
            CELL_TAIL_BLANK.replace_all(body, |_| String::new()).split('\n').map(str::to_owned).collect()
        };
        // header and align columns must be equal, rows can be different.
        if headers.len() != aligns.len() {
            return None;
        }
        let align: Vec<Option<Align>> = aligns
            .iter()
            .map(|a| {
                if ALIGN_RIGHT.test(a) {
                    Some(Align::Right)
                } else if ALIGN_CENTER.test(a) {
                    Some(Align::Center)
                } else if ALIGN_LEFT.test(a) {
                    Some(Align::Left)
                } else {
                    None
                }
            })
            .collect();
        let mut header = Vec::with_capacity(headers.len());
        for (index, text) in headers.into_iter().enumerate() {
            let id = self.inline(&text);
            header.push(TableCell { text, tokens: Vec::new(), header: true, align: align[index], queued: Some(id) });
        }
        let mut body_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut cells = Vec::new();
            for (index, text) in split_cells(row, Some(header.len())).into_iter().enumerate() {
                let id = self.inline(&text);
                cells.push(TableCell { text, tokens: Vec::new(), header: false, align: align.get(index).copied().flatten(), queued: Some(id) });
            }
            body_rows.push(cells);
        }
        let mut token = Token::new(TokenKind::Table, cap.whole());
        token.header = Some(header);
        token.align = Some(align);
        token.rows = Some(body_rows);
        Some(token)
    }

    fn lheading(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.lheading.exec(src)?;
        let text = cap.get(1).unwrap_or("");
        let id = self.inline(text);
        let mut token = queued_text(TokenKind::Heading, cap.whole(), text, id);
        token.depth = Some(if cap.get(2).is_some_and(|marks| marks.starts_with('=')) { 1 } else { 2 });
        Some(token)
    }

    fn paragraph(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.paragraph.exec(src)?;
        let first = cap.get(1).unwrap_or("");
        let text = first.strip_suffix('\n').unwrap_or(first);
        let id = self.inline(text);
        Some(queued_text(TokenKind::Paragraph, cap.whole(), text, id))
    }

    fn text(&mut self, src: &str) -> Option<Token> {
        let cap = self.rules.block.text.exec(src)?;
        let id = self.inline(cap.whole());
        Some(queued_text(TokenKind::Text, cap.whole(), cap.whole(), id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;

    fn kinds(text: &str) -> Vec<TokenKind> {
        lex(text).tokens.iter().map(|t| t.kind).collect()
    }

    #[test]
    fn cells_split_on_unescaped_pipes_only() {
        assert_eq!(split_cells("| a | b\\|c |", None), ["a", "b|c"]);
        assert_eq!(split_cells("a | b", Some(3)), ["a", "b", ""]);
        assert_eq!(split_cells("a | b | c", Some(2)), ["a", "b"]);
    }

    #[test]
    fn block_kinds_of_single_constructs() {
        assert_eq!(kinds("# T\n"), [TokenKind::Heading]);
        assert_eq!(kinds("> q\n"), [TokenKind::Blockquote]);
        assert_eq!(kinds("```js\nx\n```\n"), [TokenKind::Code]);
        assert_eq!(kinds("a\n\nb\n"), [TokenKind::Paragraph, TokenKind::Space, TokenKind::Paragraph]);
        assert_eq!(kinds("    indented\n"), [TokenKind::Code]);
    }

    #[test]
    fn a_list_is_loose_when_an_item_is_followed_by_a_blank_line() {
        let tight = lex("- a\n- b\n");
        assert_eq!(tight.tokens[0].loose, Some(false));
        let loose = lex("- a\n\n- b\n");
        assert_eq!(loose.tokens[0].loose, Some(true));
        let items = loose.tokens[0].items.as_deref().unwrap_or(&[]);
        assert!(items.iter().all(|item| item.loose == Some(true)));
    }

    #[test]
    fn task_items_and_ordered_starts() {
        let lexed = lex("3. [x] done\n4. [ ] open\n");
        let list = &lexed.tokens[0];
        assert_eq!(list.ordered, Some(true));
        assert_eq!(list.start, Some(ListStart::Number(3)));
        let items = list.items.as_deref().unwrap_or(&[]);
        assert_eq!(items[0].checked, Some(true));
        assert_eq!(items[1].checked, Some(false));
        assert_eq!(items[0].text.as_deref(), Some("done"));
    }

    #[test]
    fn a_setext_heading_and_an_unclosed_fence() {
        assert_eq!(kinds("Title\n=====\n"), [TokenKind::Heading]);
        let lexed = lex("```rust\nfn x() {}\n");
        assert_eq!(lexed.tokens[0].kind, TokenKind::Code);
        assert_eq!(lexed.tokens[0].lang.as_deref(), Some("rust"));
        assert_eq!(lexed.tokens[0].text.as_deref(), Some("fn x() {}"));
    }

    #[test]
    fn a_table_keeps_its_alignment_and_escaped_pipes() {
        let lexed = lex("| a | b |\n|:--|--:|\n| x\\|y | z |\n");
        let table = &lexed.tokens[0];
        assert_eq!(table.align, Some(vec![Some(Align::Left), Some(Align::Right)]));
        let rows = table.rows.as_deref().unwrap_or(&[]);
        assert_eq!(rows[0][0].text, "x|y");
        assert!(!rows[0][0].tokens.is_empty());
    }
}
