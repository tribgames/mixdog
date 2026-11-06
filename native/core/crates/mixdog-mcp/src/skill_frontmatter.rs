//! Writes a skill's name, description and trigger into its `SKILL.md`, the way the Node product
//! does (`createSkillDocument` / `updateSkillDocument` over the `yaml` package).
//!
//! Node parses the frontmatter into a YAML document, sets the three keys and prints the whole
//! document again. This port edits the frontmatter text in place instead: only the lines of the
//! three keys change, every other byte (comments, extra keys, their quoting and layout) stays as
//! the user wrote it. Each new value is printed exactly as the `yaml` package prints it:
//! - an existing value keeps its scalar style (plain, quoted, block) and its trailing comment;
//! - a new key is appended at the end of the mapping as a plain scalar;
//! - strings fold at 80 columns, quote when a plain scalar would read back as another type, and
//!   switch to block style for multi-line text.
//!
//! The frontmatter text is written with `\n` line ends, as Node prints it. Frontmatter whose
//! three values Node would print through machinery this port does not carry (a flow-style
//! mapping, an alias, a tag other than `!!str`, a flow or collection value) is refused with
//! [`SkillDocumentError::Unsupported`] instead of being rewritten.

use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::json_quote;
use mixdog_js::utf16_len;

use crate::skills::DESCRIPTION_MAX;
use crate::skills::SkillDocumentError;
use crate::skills::WHEN_TO_USE_MAX;
use crate::skills::frontmatter_of;
use crate::skills::validate_name;

const INDENT: &str = "  ";
const LINE_WIDTH: isize = 80;
const MIN_CONTENT_WIDTH: isize = 20;
/// `doubleQuotedMinMultiLineLength`: shorter JSON text keeps its `\n` escapes on one line.
const DOUBLE_QUOTED_MIN_MULTILINE: usize = 40;

/// What the caller asks to store; trimmed and checked like Node's `validateSkill*` functions.
pub struct Fields<'a> {
    pub name: &'a str,
    pub description: &'a str,
    pub when_to_use: &'a str,
}

struct Checked {
    name: String,
    description: String,
    when_to_use: String,
}

fn check(fields: &Fields) -> Result<Checked, SkillDocumentError> {
    let name = js_trim(fields.name);
    validate_name(name)?;
    let description = js_trim(fields.description);
    if description.is_empty() {
        return Err(SkillDocumentError::DescriptionRequired);
    }
    if utf16_len(description) > DESCRIPTION_MAX {
        return Err(SkillDocumentError::DescriptionTooLong);
    }
    let when_to_use = js_trim(fields.when_to_use);
    if utf16_len(when_to_use) > WHEN_TO_USE_MAX {
        return Err(SkillDocumentError::WhenToUseTooLong);
    }
    Ok(Checked { name: name.to_owned(), description: description.to_owned(), when_to_use: when_to_use.to_owned() })
}

fn render(front: &str, body: &str) -> Result<String, SkillDocumentError> {
    let body = body.replace("\r\n", "\n");
    let instructions = js_trim(&body);
    if instructions.is_empty() {
        return Err(SkillDocumentError::InstructionsRequired);
    }
    Ok(format!("---\n{}\n---\n\n{instructions}\n", js_trim_end(front)))
}

/// `createSkillDocument`.
pub fn create_document(fields: &Fields, body: &str) -> Result<String, SkillDocumentError> {
    let checked = check(fields)?;
    let mut pairs = vec![pair("name", &checked.name, &Site::fresh()), pair("description", &checked.description, &Site::fresh())];
    if !checked.when_to_use.is_empty() {
        pairs.push(pair("when_to_use", &checked.when_to_use, &Site::fresh()));
    }
    render(&pairs.join("\n"), body)
}

/// `updateSkillDocument`.
pub fn update_document(markdown: &str, fields: &Fields, body: &str) -> Result<String, SkillDocumentError> {
    let front = frontmatter_of(markdown)?;
    let checked = check(fields)?;
    let normalized = front.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let entries = entries(&lines)?;
    let Some(last) = entries.last() else {
        return Err(SkillDocumentError::Unsupported("a frontmatter without top-level keys"));
    };
    let wanted: [(&str, Option<&String>); 3] = [
        ("name", Some(&checked.name)),
        ("description", Some(&checked.description)),
        ("when_to_use", (!checked.when_to_use.is_empty()).then_some(&checked.when_to_use)),
    ];
    let mut edits: Vec<Edit> = Vec::new();
    let mut appended: Vec<String> = Vec::new();
    for (key, value) in wanted {
        let position = entries.iter().position(|e| e.key == key);
        match (position, value) {
            (Some(at), Some(value)) => {
                let entry = &entries[at];
                let (site, scalar_end) = value_site(&lines, entry)?;
                edits.push(Edit { from: entry.start, to: scalar_end, text: vec![pair(&entry.key_text, value, &site)] });
            }
            (None, Some(value)) => appended.push(pair(key, value, &Site::fresh())),
            (Some(at), None) => {
                let entry = &entries[at];
                // The comment lines written directly above a key belong to it; so, past the first
                // key, do the blank lines and comments since the previous key.
                let from = if at == 0 {
                    let mut from = entry.start;
                    while from > 0 && !is_blank(lines[from - 1]) {
                        from -= 1;
                    }
                    from
                } else {
                    entries[at - 1].end
                };
                edits.push(Edit { from, to: entry.end, text: Vec::new() });
            }
            (None, None) => {}
        }
    }
    if !appended.is_empty() {
        edits.push(Edit { from: last.end, to: last.end, text: appended });
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.from));
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
    for edit in edits {
        let text: Vec<String> = edit.text.iter().flat_map(|t| t.split('\n').map(str::to_owned)).collect();
        out.splice(edit.from..edit.to, text);
    }
    render(&out.join("\n"), body)
}

struct Edit {
    from: usize,
    to: usize,
    text: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Locating the keys.

struct Entry {
    key: String,
    /// The key as written, up to its colon.
    key_text: String,
    /// Byte offset just past the colon on the key's line.
    after: usize,
    start: usize,
    /// One past the last line the entry's value occupies (indented lines, block content).
    end: usize,
}

fn indent_of(line: &str) -> usize {
    line.bytes().take_while(|b| *b == b' ').count()
}

fn is_blank(line: &str) -> bool {
    line.trim_matches([' ', '\t']).is_empty()
}

fn is_seq_dash(line: &str) -> bool {
    line == "-" || line.starts_with("- ")
}

/// A `#` that starts a comment: the first one preceded by white space.
fn find_comment(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    (1..bytes.len()).find(|&i| bytes[i] == b'#' && (bytes[i - 1] == b' ' || bytes[i - 1] == b'\t'))
}

fn parse_key(line: &str) -> Option<(String, String, usize)> {
    let first = line.chars().next()?;
    if first == '"' || first == '\'' {
        let mut chars = line.char_indices().skip(1);
        let mut closed = None;
        while let Some((i, c)) = chars.next() {
            if first == '"' && c == '\\' {
                chars.next();
            } else if c == first {
                if first == '\'' && line[i + 1..].starts_with('\'') {
                    chars.next();
                } else {
                    closed = Some(i);
                    break;
                }
            }
        }
        let close = closed?;
        let after = line[close + 1..].trim_start_matches([' ', '\t']);
        let colon = line.len() - after.len();
        if !after.starts_with(':') || !matches!(after[1..].chars().next(), None | Some(' ' | '\t')) {
            return None;
        }
        let inner = &line[1..close];
        let key = if inner.contains('\\') || inner.contains("''") { String::new() } else { inner.to_owned() };
        return Some((key, line[..=close].to_owned(), colon + 1));
    }
    if "#&*!|>%@`[{?".contains(first) || is_seq_dash(line) {
        return None;
    }
    let bytes = line.as_bytes();
    let colon = (0..bytes.len()).find(|&i| bytes[i] == b':' && (i + 1 == bytes.len() || bytes[i + 1] == b' ' || bytes[i + 1] == b'\t'))?;
    let key_text = line[..colon].trim_end_matches([' ', '\t']);
    if key_text.is_empty() || find_comment(key_text).is_some() {
        return None;
    }
    Some((key_text.to_owned(), key_text.to_owned(), colon + 1))
}

fn entries(lines: &[&str]) -> Result<Vec<Entry>, SkillDocumentError> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with('{') {
            return Err(SkillDocumentError::Unsupported("a flow-style frontmatter mapping"));
        }
        let Some((key, key_text, after)) = parse_key(line) else {
            i += 1;
            continue;
        };
        let mut last = i;
        let mut j = i + 1;
        while j < lines.len() {
            let next = lines[j];
            if is_blank(next) {
                j += 1;
            } else if indent_of(next) > 0 || is_seq_dash(next) {
                last = j;
                j += 1;
            } else {
                break;
            }
        }
        out.push(Entry { key, key_text, after, start: i, end: last + 1 });
        i = last + 1;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The value of an existing key.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A scalar built in memory: no style yet, so the writer chooses.
    Unset,
    Plain,
    Double,
    Single,
    Literal,
    Folded,
}

struct Site {
    kind: Kind,
    /// `&anchor` and `!!str`, in the order the writer prints them.
    props: String,
    /// The comment after the value (text after its `#`).
    comment: Option<String>,
    /// Comments between the key and a value that starts on a later line.
    comment_before: Vec<String>,
    /// A blank line between the key and a value that starts on a later line.
    space_before: bool,
}

impl Site {
    fn fresh() -> Self {
        Self { kind: Kind::Unset, props: String::new(), comment: None, comment_before: Vec::new(), space_before: false }
    }
}

/// The scalar of `entry` as written: its style, properties and comments, and the line after its
/// last line (the lines in between are what a new value replaces).
fn value_site(lines: &[&str], entry: &Entry) -> Result<(Site, usize), SkillDocumentError> {
    let mut site = Site::fresh();
    site.kind = Kind::Plain;
    let rest = lines[entry.start][entry.after..].trim_start_matches([' ', '\t']);
    let (at, mut text, on_later_line) = if rest.is_empty() || rest.starts_with('#') {
        let key_comment = rest.strip_prefix('#');
        let mut own: Vec<String> = Vec::new();
        let mut blank_first = false;
        let mut found = None;
        let mut j = entry.start + 1;
        while j < entry.end {
            let line = lines[j];
            if is_blank(line) {
                blank_first |= own.is_empty();
            } else if let Some(comment) = line.trim_start_matches(' ').strip_prefix('#') {
                own.push(comment.to_owned());
            } else {
                found = Some(j);
                break;
            }
            j += 1;
        }
        let Some(at) = found else {
            site.comment = key_comment.map(str::to_owned);
            return Ok((site, entry.start + 1));
        };
        site.comment_before.extend(key_comment.map(str::to_owned));
        site.comment_before.append(&mut own);
        site.space_before = blank_first;
        (at, lines[at].trim_start_matches(' '), true)
    } else {
        (entry.start, rest, false)
    };
    if on_later_line && (is_seq_dash(text) || parse_key(text).is_some()) {
        return Err(SkillDocumentError::Unsupported("a collection as the value of name, description or when_to_use"));
    }
    let (mut anchor, mut tag) = (None, None);
    while text.starts_with('&') || text.starts_with('!') {
        let token_end = text.find([' ', '\t']).unwrap_or(text.len());
        let token = &text[..token_end];
        if token.starts_with('&') {
            anchor = Some(token);
        } else if token == "!!str" {
            tag = Some(token);
        } else {
            return Err(SkillDocumentError::Unsupported("a tag other than !!str"));
        }
        text = text[token_end..].trim_start_matches([' ', '\t']);
        if text.is_empty() {
            return Err(SkillDocumentError::Unsupported("a property without a value on its line"));
        }
    }
    site.props = [anchor, tag].into_iter().flatten().collect::<Vec<_>>().join(" ");
    let column = lines[at].len() - text.len();
    let scalar_end = match text.chars().next() {
        // Setting a key whose value is an alias replaces the alias node by a new scalar.
        Some('*') => {
            site = Site { comment_before: site.comment_before, space_before: site.space_before, ..Site::fresh() };
            at + 1
        }
        Some('[' | '{') => return Err(SkillDocumentError::Unsupported("a flow collection as the value of name, description or when_to_use")),
        Some(quote @ ('"' | '\'')) => {
            site.kind = if quote == '"' { Kind::Double } else { Kind::Single };
            let (end_line, end_byte) = closing_quote(lines, at, column + 1, quote)
                .ok_or(SkillDocumentError::Unsupported("a quoted value without its closing quote"))?;
            let tail = lines[end_line][end_byte + 1..].trim_start_matches([' ', '\t']);
            match tail.strip_prefix('#') {
                Some(comment) => site.comment = Some(comment.to_owned()),
                None if tail.is_empty() => {}
                None => return Err(SkillDocumentError::Unsupported("text after a quoted value")),
            }
            end_line + 1
        }
        Some(indicator @ ('|' | '>')) => {
            site.kind = if indicator == '|' { Kind::Literal } else { Kind::Folded };
            let header = &text[1..];
            let token_end = header.find([' ', '\t']).unwrap_or(header.len());
            let explicit = header[..token_end].chars().find_map(|c| c.to_digit(10)).map(|d| d as usize);
            if let Some(comment) = header[token_end..].trim_start_matches([' ', '\t']).strip_prefix('#') {
                site.comment = Some(comment.to_owned());
            }
            let mut content_indent = explicit;
            let mut last = at;
            for (k, line) in lines.iter().enumerate().skip(at + 1) {
                if is_blank(line) {
                    continue;
                }
                let indent = indent_of(line);
                let content = *content_indent.get_or_insert(indent);
                if indent == 0 || indent < content {
                    break;
                }
                last = k;
            }
            // Keep chomping makes the blank lines after the text part of the value.
            if header[..token_end].contains('+') {
                while lines.get(last + 1).is_some_and(|l| is_blank(l)) {
                    last += 1;
                }
            }
            last + 1
        }
        _ => {
            let mut last = at;
            let mut line_text = text;
            let mut k = at;
            loop {
                if let Some(c) = find_comment(line_text) {
                    site.comment = Some(line_text[c + 1..].to_owned());
                    break;
                }
                // The next line continues the scalar when it is indented text (not a comment).
                let next = (k + 1..entry.end).find(|&m| !is_blank(lines[m]));
                match next {
                    Some(m) if indent_of(lines[m]) > 0 && !lines[m].trim_start_matches(' ').starts_with('#') => {
                        k = m;
                        last = m;
                        line_text = lines[m].trim_start_matches(' ');
                    }
                    _ => break,
                }
            }
            last + 1
        }
    };
    Ok((site, scalar_end))
}

/// The position of the quote closing the scalar whose content starts at `lines[line][byte..]`.
fn closing_quote(lines: &[&str], line: usize, byte: usize, quote: char) -> Option<(usize, usize)> {
    let (mut l, mut p) = (line, byte);
    loop {
        let s = lines.get(l)?;
        if p >= s.len() {
            l += 1;
            p = 0;
            continue;
        }
        let c = s[p..].chars().next()?;
        if quote == '"' && c == '\\' {
            p += 1;
            match s.get(p..).and_then(|rest| rest.chars().next()) {
                Some(escaped) => p += escaped.len_utf8(),
                None => {
                    l += 1;
                    p = 0;
                }
            }
        } else if c == quote {
            if quote == '\'' && s[p + 1..].starts_with('\'') {
                p += 2;
            } else {
                return Some((l, p));
            }
        } else {
            p += c.len_utf8();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Printing a pair, as the `yaml` package's `stringifyPair` does for a scalar value.

fn comment_string(text: &str) -> String {
    match text {
        "" => String::new(),
        " " => "#".to_owned(),
        _ => format!("#{text}"),
    }
}

fn pair(key_text: &str, value: &str, site: &Site) -> String {
    let mut out = format!("{key_text}:");
    // A value built in memory is no node when the pair is printed, so the column where it starts
    // is unknown and its first line folds at the width less the indent.
    let mut indent_at_start = (site.kind != Kind::Unset).then(|| utf16_len(&out) + 1);
    if !site.props.is_empty() {
        indent_at_start = indent_at_start.map(|column| column + utf16_len(&site.props) + 1);
    }
    let (printed, comment_done) = scalar_string(value, site.kind, site.comment.as_deref(), indent_at_start);
    let printed = if site.props.is_empty() { printed } else { format!("{} {printed}", site.props) };
    let separator = if site.space_before || !site.comment_before.is_empty() {
        let mut ws = if site.space_before { "\n" } else { "" }.to_owned();
        if !site.comment_before.is_empty() {
            let lines: Vec<String> = site.comment_before.iter().map(|c| format!("{INDENT}{}", comment_string(c))).collect();
            ws.push('\n');
            ws.push_str(&lines.join("\n"));
        }
        ws.push('\n');
        ws.push_str(INDENT);
        ws
    } else if printed.is_empty() || printed.starts_with('\n') {
        String::new()
    } else {
        " ".to_owned()
    };
    out.push_str(&separator);
    out.push_str(&printed);
    if let Some(comment) = &site.comment
        && !comment_done
    {
        if !out.ends_with(' ') {
            out.push(' ');
        }
        out.push_str(&comment_string(comment));
    }
    out
}

fn re(pattern: &str, flags: &str) -> JsRegex {
    JsRegex::new_static(pattern, flags)
}

static PLAIN_UNSAFE: LazyLock<JsRegex> =
    LazyLock::new(|| re(r#"^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#, ""));
static CONTROL: LazyLock<JsRegex> = LazyLock::new(|| re(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", ""));
static NEWLINES: LazyLock<JsRegex> = LazyLock::new(|| re(r"\n+", "g"));
static WHITESPACE_AROUND_NEWLINE: LazyLock<JsRegex> = LazyLock::new(|| re(r"[ \t]\n|\n[ \t]", ""));
static ENDS_IN_BLANK_LINE: LazyLock<JsRegex> = LazyLock::new(|| re(r"\n[\t ]+$", ""));
static BLOCK_END_NEWLINES: LazyLock<JsRegex> = LazyLock::new(|| re(r"(^|(?<!\n))\n+(?!\n|$)", "g"));
static MORE_INDENTED: LazyLock<JsRegex> = LazyLock::new(|| re(r"(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?", "g"));
/// The core schema's implicit types: a plain string reading back as one of them is quoted.
static IMPLICIT_TYPES: LazyLock<Vec<JsRegex>> = LazyLock::new(|| {
    [
        r"^(?:~|[Nn]ull|NULL)?$",
        r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$",
        r"^0o[0-7]+$",
        r"^[-+]?[0-9]+$",
        r"^0x[0-9a-fA-F]+$",
        r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$",
        r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$",
        r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$",
    ]
    .iter()
    .map(|p| re(p, ""))
    .collect()
});

/// Every match of `pattern` followed by `extra` (`replace(re, `$&${extra}`)`).
fn append_after(pattern: &JsRegex, text: &str, extra: &str) -> String {
    pattern.replace_all_with(text, |c| format!("{}{extra}", c.get(0).unwrap_or_default()))
}

/// `lineLengthOverLimit`: some line of `text` is longer than the width left after `indent`.
fn line_length_over_limit(text: &str, indent: usize) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    let limit = LINE_WIDTH as usize - indent;
    if units.len() <= limit {
        return false;
    }
    let mut start = 0;
    for (i, unit) in units.iter().enumerate() {
        if *unit == u16::from(b'\n') {
            if i - start > limit {
                return true;
            }
            start = i + 1;
            if units.len() - start <= limit {
                return false;
            }
        }
    }
    true
}

/// `stringifyString` for a string in block-mapping value position. Returns the text and whether
/// it already carries `comment` (a block scalar's header does).
fn scalar_string(value: &str, kind: Kind, comment: Option<&str>, indent_at_start: Option<usize>) -> (String, bool) {
    let dispatch = if kind != Kind::Double && CONTROL.is_match(value) { Kind::Double } else { kind };
    match dispatch {
        Kind::Literal | Kind::Folded => block_string(value, kind, comment, indent_at_start),
        Kind::Double => (double_quoted(value, indent_at_start), false),
        Kind::Single => (single_quoted(value, indent_at_start), false),
        Kind::Plain | Kind::Unset => plain_string(value, kind, comment, indent_at_start),
    }
}

fn plain_string(value: &str, kind: Kind, comment: Option<&str>, indent_at_start: Option<usize>) -> (String, bool) {
    if PLAIN_UNSAFE.is_match(value) {
        return if value.contains('\n') {
            block_string(value, kind, comment, indent_at_start)
        } else {
            (quoted_string(value, indent_at_start), false)
        };
    }
    if kind != Kind::Plain && value.contains('\n') {
        return block_string(value, kind, comment, indent_at_start);
    }
    let text = append_after(&NEWLINES, value, &format!("\n{INDENT}"));
    if IMPLICIT_TYPES.iter().any(|t| t.is_match(&text)) {
        return (quoted_string(value, indent_at_start), false);
    }
    (fold_flow_lines(&text, INDENT, Mode::Flow, indent_at_start, false).0, false)
}

fn quoted_string(value: &str, indent_at_start: Option<usize>) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single {
        single_quoted(value, indent_at_start)
    } else {
        double_quoted(value, indent_at_start)
    }
}

fn single_quoted(value: &str, indent_at_start: Option<usize>) -> String {
    if WHITESPACE_AROUND_NEWLINE.is_match(value) {
        return double_quoted(value, indent_at_start);
    }
    let escaped = value.replace('\'', "''");
    let text = format!("'{}'", append_after(&NEWLINES, &escaped, &format!("\n{INDENT}")));
    fold_flow_lines(&text, INDENT, Mode::Flow, indent_at_start, false).0
}

fn double_quoted(value: &str, indent_at_start: Option<usize>) -> String {
    let mut json = String::new();
    json_quote(value, &mut json);
    let json_len = utf16_len(&json);
    let c: Vec<char> = json.chars().collect();
    let at = |k: usize| c.get(k).copied();
    let mut out = String::new();
    let mut start = 0;
    let mut i = 0;
    while i < c.len() {
        let mut ch = c[i];
        if ch == ' ' && at(i + 1) == Some('\\') && at(i + 2) == Some('n') {
            out.extend(&c[start..i]);
            out.push_str("\\ ");
            i += 1;
            start = i;
            ch = '\\';
        }
        if ch == '\\' {
            match at(i + 1) {
                Some('u') => {
                    out.extend(&c[start..i]);
                    let code: String = c[i + 2..(i + 6).min(c.len())].iter().collect();
                    match code.as_str() {
                        "0000" => out.push_str("\\0"),
                        "0007" => out.push_str("\\a"),
                        "000b" => out.push_str("\\v"),
                        "001b" => out.push_str("\\e"),
                        "0085" => out.push_str("\\N"),
                        "00a0" => out.push_str("\\_"),
                        "2028" => out.push_str("\\L"),
                        "2029" => out.push_str("\\P"),
                        other if other.starts_with("00") => {
                            out.push_str("\\x");
                            out.push_str(&other[2..]);
                        }
                        _ => out.extend(&c[i..(i + 6).min(c.len())]),
                    }
                    i += 5;
                    start = i + 1;
                }
                Some('n') => {
                    if at(i + 2) == Some('"') || json_len < DOUBLE_QUOTED_MIN_MULTILINE {
                        i += 1;
                    } else {
                        out.extend(&c[start..i]);
                        out.push_str("\n\n");
                        while at(i + 2) == Some('\\') && at(i + 3) == Some('n') && at(i + 4) != Some('"') {
                            out.push('\n');
                            i += 2;
                        }
                        out.push_str(INDENT);
                        if at(i + 2) == Some(' ') {
                            out.push('\\');
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let text = if start > 0 {
        out.extend(&c[start.min(c.len())..]);
        out
    } else {
        json
    };
    fold_flow_lines(&text, INDENT, Mode::Quoted, indent_at_start, false).0
}

fn block_string(value: &str, kind: Kind, comment: Option<&str>, indent_at_start: Option<usize>) -> (String, bool) {
    if ENDS_IN_BLANK_LINE.is_match(value) {
        return (quoted_string(value, indent_at_start), false);
    }
    let literal = match kind {
        Kind::Folded => false,
        Kind::Literal => true,
        _ => !line_length_over_limit(value, INDENT.len()),
    };
    if value.is_empty() {
        return (if literal { "|\n" } else { ">\n" }.to_owned(), false);
    }
    let bytes = value.as_bytes();
    let mut end_start = bytes.len();
    while end_start > 0 && matches!(bytes[end_start - 1], b'\n' | b'\t' | b' ') {
        end_start -= 1;
    }
    let mut end = value[end_start..].to_owned();
    let chomp = match end.find('\n') {
        None => "-",
        Some(position) if value.len() == end.len() || position != end.len() - 1 => "+",
        Some(_) => "",
    };
    let mut value = value[..end_start].to_owned();
    if !end.is_empty() {
        if end.ends_with('\n') {
            end.pop();
        }
        end = append_after(&BLOCK_END_NEWLINES, &end, INDENT);
    }
    let mut start_with_space = false;
    let mut last_newline = None;
    for (i, b) in value.bytes().enumerate() {
        match b {
            b' ' => start_with_space = true,
            b'\n' => last_newline = Some(i),
            _ => break,
        }
    }
    let mut start = value[..last_newline.map_or(0, |n| n + 1)].to_owned();
    if !start.is_empty() {
        value = value[start.len()..].to_owned();
        start = append_after(&NEWLINES, &start, INDENT);
    }
    let mut header = format!("{}{chomp}", if start_with_space { "2" } else { "" });
    let mut comment_done = false;
    if let Some(comment) = comment {
        header.push(' ');
        header.push_str(&comment_string(comment));
        comment_done = true;
    }
    if !literal {
        let doubled = NEWLINES.replace_all_with(&value, |c| format!("\n{}", c.get(0).unwrap_or_default()));
        let unfolded = MORE_INDENTED
            .replace_all_with(&doubled, |c| format!("{}{}", c.get(1).unwrap_or_default(), c.get(2).unwrap_or_default()));
        let folded_value = append_after(&NEWLINES, &unfolded, INDENT);
        let track_overflow = kind != Kind::Folded;
        let (body, overflowed) =
            fold_flow_lines(&format!("{start}{folded_value}{end}"), INDENT, Mode::Block, Some(INDENT.len()), track_overflow);
        if !overflowed {
            return (format!(">{header}\n{INDENT}{body}"), comment_done);
        }
    }
    let value = append_after(&NEWLINES, &value, INDENT);
    (format!("|{header}\n{INDENT}{start}{value}{end}"), comment_done)
}

// ---------------------------------------------------------------------------------------------
// `foldFlowLines`, over UTF-16 units like the original.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Flow,
    Block,
    Quoted,
}

/// Index of the last newline of the more-indented lines that follow position `i`.
fn consume_more_indented_lines(t: &[u16], mut i: isize, indent: isize) -> isize {
    let at = |k: isize| usize::try_from(k).ok().and_then(|k| t.get(k).copied());
    let mut end = i;
    let mut start = i + 1;
    let mut ch = at(start);
    while ch == Some(u16::from(b' ')) || ch == Some(u16::from(b'\t')) {
        if i < start + indent {
            i += 1;
            ch = at(i);
        } else {
            loop {
                i += 1;
                ch = at(i);
                if ch.is_none() || ch == Some(u16::from(b'\n')) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = at(start);
        }
    }
    end
}

/// Returns the folded text and whether a line could not be folded (`onOverflow`, reported only
/// when `track_overflow`).
fn fold_flow_lines(text: &str, indent: &str, mode: Mode, indent_at_start: Option<usize>, track_overflow: bool) -> (String, bool) {
    let t: Vec<u16> = text.encode_utf16().collect();
    let at = |k: isize| usize::try_from(k).ok().and_then(|k| t.get(k).copied());
    let unit = |c: u8| Some(u16::from(c));
    let indent_len = indent.len() as isize;
    let end_step = (1 + MIN_CONTENT_WIDTH).max(1 + LINE_WIDTH - indent_len);
    if t.len() as isize <= end_step {
        return (text.to_owned(), false);
    }
    let mut folds: Vec<isize> = Vec::new();
    let mut escaped_folds: HashSet<isize> = HashSet::new();
    let mut end = LINE_WIDTH - indent_len;
    if let Some(column) = indent_at_start {
        if column as isize > LINE_WIDTH - 2.max(MIN_CONTENT_WIDTH) {
            folds.push(0);
        } else {
            end = LINE_WIDTH - column as isize;
        }
    }
    let mut split: Option<isize> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i: isize = -1;
    let (mut esc_start, mut esc_end): (isize, isize) = (-1, -1);
    if mode == Mode::Block {
        i = consume_more_indented_lines(&t, i, indent_len);
        if i != -1 {
            end = i + end_step;
        }
    }
    loop {
        i += 1;
        let Some(first) = at(i) else { break };
        let mut ch = Some(first);
        if mode == Mode::Quoted && ch == unit(b'\\') {
            esc_start = i;
            match at(i + 1) {
                x if x == unit(b'x') => i += 3,
                x if x == unit(b'u') => i += 5,
                x if x == unit(b'U') => i += 9,
                _ => i += 1,
            }
            esc_end = i;
        }
        if ch == unit(b'\n') {
            if mode == Mode::Block {
                i = consume_more_indented_lines(&t, i, indent_len);
            }
            end = i + indent_len + end_step;
            split = None;
        } else {
            let blank = |u: Option<u16>| u == unit(b' ') || u == unit(b'\n') || u == unit(b'\t');
            if ch == unit(b' ') && prev.is_some() && !blank(prev) {
                let next = at(i + 1);
                if next.is_some() && !blank(next) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(at_split) = split.filter(|s| *s != 0) {
                    folds.push(at_split);
                    end = at_split + end_step;
                    split = None;
                } else if mode == Mode::Quoted {
                    while prev == unit(b' ') || prev == unit(b'\t') {
                        prev = ch;
                        i += 1;
                        ch = at(i);
                        overflow = true;
                    }
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    if escaped_folds.contains(&j) {
                        return (text.to_owned(), false);
                    }
                    folds.push(j);
                    escaped_folds.insert(j);
                    end = j + end_step;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        prev = ch;
    }
    let overflowed = overflow && track_overflow;
    if folds.is_empty() {
        return (text.to_owned(), overflowed);
    }
    let slice = |from: isize, to: isize| -> Vec<u16> {
        let (from, to) = (from.max(0) as usize, (to.max(0) as usize).min(t.len()));
        if from < to { t[from..to].to_vec() } else { Vec::new() }
    };
    let indent_units: Vec<u16> = indent.encode_utf16().collect();
    let newline_indent = |out: &mut Vec<u16>| {
        out.push(u16::from(b'\n'));
        out.extend(&indent_units);
    };
    let mut res = slice(0, folds[0]);
    for (n, fold) in folds.iter().copied().enumerate() {
        let stop = folds.get(n + 1).copied().filter(|f| *f != 0).unwrap_or(t.len() as isize);
        if fold == 0 {
            res.clear();
            newline_indent(&mut res);
            res.extend(slice(0, stop));
        } else {
            if mode == Mode::Quoted && escaped_folds.contains(&fold) {
                if let Some(unit) = at(fold) {
                    res.push(unit);
                }
                res.push(u16::from(b'\\'));
            }
            newline_indent(&mut res);
            res.extend(slice(fold + 1, stop));
        }
    }
    (String::from_utf16_lossy(&res), overflowed)
}
