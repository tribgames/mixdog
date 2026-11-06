//! A frontmatter written as one flow mapping (`{name: x, description: y}`), rewritten the way the
//! `yaml` package rewrites it: parsed into nodes, the three keys set, and the whole mapping
//! printed again (`stringifyCollection` / `stringifyPair` in flow context). Unlike a block
//! mapping, whose text `skill_frontmatter` keeps byte for byte, a flow mapping is reformatted:
//! it prints on one line when it fits the line width and one item per line otherwise.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::number_to_string;
use mixdog_js::utf16_len;

use crate::skill_frontmatter::Ctx;
use crate::skill_frontmatter::Kind;
use crate::skill_frontmatter::comment_string;
use crate::skill_frontmatter::props_text;
use crate::skill_frontmatter::tagged_string;
use crate::skill_frontmatter::to_exponential;
use crate::skills::SkillDocumentError;

const STEP: &str = "  ";
const LINE_WIDTH: usize = 80;

fn re(pattern: &str) -> JsRegex {
    JsRegex::new_static(pattern, "")
}

static NULL: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(?:~|[Nn]ull|NULL)?$"));
static BOOL: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$"));
static INT_OCT: LazyLock<JsRegex> = LazyLock::new(|| re(r"^0o[0-7]+$"));
static INT_DEC: LazyLock<JsRegex> = LazyLock::new(|| re(r"^[-+]?[0-9]+$"));
static INT_HEX: LazyLock<JsRegex> = LazyLock::new(|| re(r"^0x[0-9a-fA-F]+$"));
static FLOAT_NAN: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$"));
static FLOAT_EXP: LazyLock<JsRegex> = LazyLock::new(|| re(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$"));
static FLOAT: LazyLock<JsRegex> = LazyLock::new(|| re(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$"));

// ---------------------------------------------------------------------------------------------
// Nodes.

#[derive(Clone, Copy)]
enum Fmt {
    Dec,
    Oct,
    Hex,
    /// `.nan` and `.inf`.
    Special,
    Exp,
    /// Plain decimals; keeps the fraction digits the text had.
    Float(usize),
}

#[derive(Clone)]
enum Val {
    Str(String),
    Null,
    /// The text of a boolean is kept as written (`source`).
    Bool,
    Num(f64, Fmt),
}

#[derive(Clone)]
struct Scalar {
    val: Val,
    kind: Kind,
    source: String,
}

#[derive(Clone)]
enum Body {
    Scalar(Scalar),
    Alias(String),
    Map(Vec<Pair>),
    Seq(Vec<Item>),
}

#[derive(Clone)]
struct Node {
    anchor: Option<String>,
    tag: Option<String>,
    comment_before: Option<String>,
    comment: Option<String>,
    space_before: bool,
    /// A value built in memory (no node when its pair is printed).
    raw: bool,
    body: Body,
}

#[derive(Clone)]
enum Item {
    Node(Node),
    Pair(Pair),
}

#[derive(Clone)]
struct Pair {
    key: Option<Node>,
    value: Option<Node>,
}

impl Node {
    fn new(body: Body) -> Self {
        Self { anchor: None, tag: None, comment_before: None, comment: None, space_before: false, raw: false, body }
    }

    fn raw_string(text: &str) -> Self {
        Self { raw: true, ..Self::new(Body::Scalar(Scalar { val: Val::Str(text.to_owned()), kind: Kind::Unset, source: String::new() })) }
    }

    fn is_collection(&self) -> bool {
        matches!(self.body, Body::Map(_) | Body::Seq(_))
    }

    fn is_scalar(&self) -> bool {
        matches!(self.body, Body::Scalar(_))
    }
}

// ---------------------------------------------------------------------------------------------
// Parsing.

fn invalid(message: &str) -> SkillDocumentError {
    SkillDocumentError::InvalidYaml(message.to_owned())
}

struct Gap {
    /// Comment texts, and whether each sat on the line the previous token ended on.
    comments: Vec<(String, bool)>,
    blank_line: bool,
}

struct Parser {
    c: Vec<char>,
    i: usize,
}

fn is_flow_indicator(c: char) -> bool {
    matches!(c, ',' | '[' | ']' | '{' | '}')
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.c.get(self.i).copied()
    }

    fn at(&self, offset: usize) -> Option<char> {
        self.c.get(self.i + offset).copied()
    }

    /// Skips white space and comments.
    fn gap(&mut self) -> Gap {
        let mut gap = Gap { comments: Vec::new(), blank_line: false };
        let mut same_line = true;
        let mut newlines = 0;
        while let Some(ch) = self.peek() {
            match ch {
                ' ' | '\t' => self.i += 1,
                '\n' => {
                    self.i += 1;
                    same_line = false;
                    newlines += 1;
                    if newlines >= 2 {
                        gap.blank_line = true;
                    }
                }
                '#' if self.i == 0 || matches!(self.c[self.i - 1], ' ' | '\t' | '\n') => {
                    let start = self.i + 1;
                    while self.peek().is_some_and(|c| c != '\n') {
                        self.i += 1;
                    }
                    gap.comments.push((self.c[start..self.i].iter().collect(), same_line));
                    newlines = 0;
                }
                _ => break,
            }
        }
        gap
    }

    fn props(&mut self) -> (Option<String>, Option<String>) {
        let (mut anchor, mut tag) = (None, None);
        loop {
            let start = self.i;
            match self.peek() {
                Some('&') => {
                    self.i += 1;
                    while self.peek().is_some_and(|c| !c.is_whitespace() && !is_flow_indicator(c)) {
                        self.i += 1;
                    }
                    anchor = Some(self.c[start + 1..self.i].iter().collect());
                }
                Some('!') => {
                    if self.at(1) == Some('<') {
                        while self.peek().is_some_and(|c| c != '>') {
                            self.i += 1;
                        }
                        self.i += 1;
                    } else {
                        while self.peek().is_some_and(|c| !c.is_whitespace() && !is_flow_indicator(c)) {
                            self.i += 1;
                        }
                    }
                    let token: String = self.c[start..self.i].iter().collect();
                    tag = Some(crate::skill_frontmatter::tag_name(&token));
                }
                _ => return (anchor, tag),
            }
            while matches!(self.peek(), Some(' ' | '\t' | '\n')) {
                self.i += 1;
            }
        }
    }

    fn node(&mut self) -> Result<Node, SkillDocumentError> {
        let (anchor, tag) = self.props();
        let mut node = match self.peek() {
            Some('[') => self.seq()?,
            Some('{') => self.map()?,
            Some('*') => {
                let start = self.i + 1;
                while self.peek().is_some_and(|c| !c.is_whitespace() && !is_flow_indicator(c)) {
                    self.i += 1;
                }
                Node::new(Body::Alias(self.c[start..self.i].iter().collect()))
            }
            Some('"') => self.quoted('"')?,
            Some('\'') => self.quoted('\'')?,
            Some(',' | ']' | '}' | ':') | None => Node::new(Body::Scalar(Scalar { val: Val::Null, kind: Kind::Plain, source: String::new() })),
            Some(_) => {
                let text = self.plain();
                Node::new(Body::Scalar(resolve_plain(&text)))
            }
        };
        node.anchor = anchor;
        if let (Some(tag), Body::Scalar(scalar)) = (&tag, &mut node.body) {
            retype(scalar, tag);
        }
        node.tag = tag;
        Ok(node)
    }

    /// A plain scalar of flow context, its lines folded.
    fn plain(&mut self) -> String {
        let mut out = String::new();
        let mut line = String::new();
        while let Some(ch) = self.peek() {
            if is_flow_indicator(ch) {
                break;
            }
            if ch == ':' && self.at(1).is_none_or(|n| n.is_whitespace() || is_flow_indicator(n)) {
                break;
            }
            if ch == '#' && (line.is_empty() || line.ends_with([' ', '\t'])) {
                break;
            }
            if ch == '\n' {
                let mut newlines = 0;
                let mut j = self.i;
                while let Some(&next) = self.c.get(j) {
                    if next == '\n' {
                        newlines += 1;
                    } else if next != ' ' && next != '\t' {
                        break;
                    }
                    j += 1;
                }
                let next = self.c.get(j).copied();
                let ends = next.is_none_or(|n| is_flow_indicator(n) || n == '#' || (n == ':' && self.c.get(j + 1).is_none_or(|a| a.is_whitespace() || is_flow_indicator(*a))));
                if ends {
                    break;
                }
                out.push_str(line.trim_end_matches([' ', '\t']));
                line.clear();
                if newlines == 1 {
                    out.push(' ');
                } else {
                    out.push_str(&"\n".repeat(newlines - 1));
                }
                self.i = j;
                continue;
            }
            line.push(ch);
            self.i += 1;
        }
        out.push_str(line.trim_end_matches([' ', '\t']));
        out
    }

    fn quoted(&mut self, quote: char) -> Result<Node, SkillDocumentError> {
        self.i += 1;
        let mut out = String::new();
        let mut keep = 0;
        loop {
            let Some(ch) = self.peek() else { return Err(invalid("missing closing quote")) };
            self.i += 1;
            if ch == quote {
                if quote == '\'' && self.peek() == Some('\'') {
                    self.i += 1;
                    out.push('\'');
                    keep = out.len();
                    continue;
                }
                break;
            }
            if quote == '"' && ch == '\\' {
                let Some(esc) = self.peek() else { return Err(invalid("bad escape")) };
                self.i += 1;
                let hex = |p: &mut Parser, n: usize| -> Option<char> {
                    let digits: String = p.c.get(p.i..p.i + n)?.iter().collect();
                    p.i += n;
                    char::from_u32(u32::from_str_radix(&digits, 16).ok()?)
                };
                match esc {
                    '\n' => {
                        while matches!(self.peek(), Some(' ' | '\t')) {
                            self.i += 1;
                        }
                        continue;
                    }
                    '0' => out.push('\0'),
                    'a' => out.push('\u{7}'),
                    'b' => out.push('\u{8}'),
                    't' | '\t' => out.push('\t'),
                    'n' => out.push('\n'),
                    'v' => out.push('\u{b}'),
                    'f' => out.push('\u{c}'),
                    'r' => out.push('\r'),
                    'e' => out.push('\u{1b}'),
                    ' ' => out.push(' '),
                    '"' => out.push('"'),
                    '/' => out.push('/'),
                    '\\' => out.push('\\'),
                    'N' => out.push('\u{85}'),
                    '_' => out.push('\u{a0}'),
                    'L' => out.push('\u{2028}'),
                    'P' => out.push('\u{2029}'),
                    'x' => out.push(hex(self, 2).ok_or_else(|| invalid("bad escape"))?),
                    'u' => out.push(hex(self, 4).ok_or_else(|| invalid("bad escape"))?),
                    'U' => out.push(hex(self, 8).ok_or_else(|| invalid("bad escape"))?),
                    _ => return Err(invalid("bad escape")),
                }
                keep = out.len();
                continue;
            }
            if ch == '\n' {
                let mut newlines = 1;
                while let Some(next) = self.peek() {
                    if next == '\n' {
                        newlines += 1;
                    } else if next != ' ' && next != '\t' {
                        break;
                    }
                    self.i += 1;
                }
                while out.len() > keep && out.ends_with([' ', '\t']) {
                    out.pop();
                }
                if newlines == 1 {
                    out.push(' ');
                } else {
                    out.push_str(&"\n".repeat(newlines - 1));
                }
                continue;
            }
            out.push(ch);
        }
        let kind = if quote == '"' { Kind::Double } else { Kind::Single };
        Ok(Node::new(Body::Scalar(Scalar { source: out.clone(), val: Val::Str(out), kind })))
    }

    /// The items of a flow collection up to its closing bracket, with their comments.
    fn items(&mut self, close: char, is_map: bool) -> Result<Vec<Item>, SkillDocumentError> {
        self.i += 1;
        let mut items: Vec<Item> = Vec::new();
        loop {
            let gap = self.gap();
            let mut before: Vec<String> = Vec::new();
            for (text, same_line) in gap.comments {
                match (same_line, items.last_mut()) {
                    (true, Some(last)) => attach_trailing(last, text),
                    _ => before.push(text),
                }
            }
            if self.peek() == Some(close) {
                self.i += 1;
                return Ok(items);
            }
            if self.peek().is_none() {
                return Err(invalid("missing closing bracket"));
            }
            let mut item = self.item(is_map)?;
            let space_before = gap.blank_line && !items.is_empty();
            let before = (!before.is_empty()).then(|| before.join("\n"));
            match &mut item {
                Item::Node(node) => {
                    node.comment_before = before;
                    node.space_before = space_before;
                }
                Item::Pair(pair) => {
                    if let Some(key) = &mut pair.key {
                        key.comment_before = before;
                        key.space_before = space_before;
                    }
                }
            }
            let after = self.gap();
            for (text, same_line) in after.comments {
                if same_line {
                    attach_trailing(&mut item, text);
                }
            }
            if self.peek() == Some(',') {
                self.i += 1;
            }
            items.push(item);
        }
    }

    fn item(&mut self, is_map: bool) -> Result<Item, SkillDocumentError> {
        let explicit = self.peek() == Some('?') && self.at(1).is_none_or(char::is_whitespace);
        if explicit {
            self.i += 1;
            self.gap();
        }
        let first = if matches!(self.peek(), Some(':' | ',' | '}' | ']')) { None } else { Some(self.node()?) };
        let mark = self.i;
        self.gap();
        if self.peek() == Some(':') {
            self.i += 1;
            self.gap();
            let value = if matches!(self.peek(), Some(',' | '}' | ']')) {
                Node::new(Body::Scalar(Scalar { val: Val::Null, kind: Kind::Plain, source: String::new() }))
            } else {
                self.node()?
            };
            let pair = Pair { key: first, value: Some(value) };
            // A `key: value` inside a flow sequence is a mapping of one pair.
            return Ok(if is_map { Item::Pair(pair) } else { Item::Node(Node::new(Body::Map(vec![pair]))) });
        }
        self.i = mark;
        match (is_map || explicit, first) {
            (true, key) => Ok(Item::Pair(Pair { key, value: None })),
            (false, Some(node)) => Ok(Item::Node(node)),
            (false, None) => Err(invalid("empty flow sequence item")),
        }
    }

    fn map(&mut self) -> Result<Node, SkillDocumentError> {
        Ok(Node::new(Body::Map(self.items('}', true)?.into_iter().filter_map(|i| if let Item::Pair(p) = i { Some(p) } else { None }).collect())))
    }

    fn seq(&mut self) -> Result<Node, SkillDocumentError> {
        Ok(Node::new(Body::Seq(self.items(']', false)?)))
    }
}

/// A comment after an item (and its comma) belongs to the item's value, or to its key when it
/// has no value.
fn attach_trailing(item: &mut Item, text: String) {
    let node = match item {
        Item::Node(node) => Some(node),
        Item::Pair(pair) => pair.value.as_mut().or(pair.key.as_mut()),
    };
    if let Some(node) = node {
        node.comment = Some(match node.comment.take() {
            Some(old) => format!("{old}\n{text}"),
            None => text,
        });
    }
}

/// A plain scalar's value by the core schema.
fn resolve_plain(text: &str) -> Scalar {
    let mut scalar = Scalar { val: Val::Str(text.to_owned()), kind: Kind::Plain, source: text.to_owned() };
    retype(&mut scalar, "");
    scalar
}

/// Resolves `scalar`'s text by `tag` (all core tags when empty).
fn retype(scalar: &mut Scalar, tag: &str) {
    let text = scalar.source.clone();
    let any = tag.is_empty();
    let wants = |name: &str| any || tag == format!("tag:yaml.org,2002:{name}");
    let parse_radix = |digits: &str, radix: u32| digits.chars().fold(0.0_f64, |n, d| n * f64::from(radix) + f64::from(d.to_digit(radix).unwrap_or(0)));
    if wants("null") && NULL.is_match(&text) {
        scalar.val = Val::Null;
    } else if wants("bool") && BOOL.is_match(&text) {
        scalar.val = Val::Bool;
    } else if wants("int") && INT_OCT.is_match(&text) {
        scalar.val = Val::Num(parse_radix(&text[2..], 8), Fmt::Oct);
    } else if wants("int") && INT_DEC.is_match(&text) {
        scalar.val = Val::Num(text.trim_start_matches('+').parse::<f64>().unwrap_or(f64::NAN), Fmt::Dec);
    } else if wants("int") && INT_HEX.is_match(&text) {
        scalar.val = Val::Num(parse_radix(&text[2..], 16), Fmt::Hex);
    } else if wants("float") && FLOAT_NAN.is_match(&text) {
        let n = if text.to_lowercase().ends_with("nan") {
            f64::NAN
        } else if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
        scalar.val = Val::Num(n, Fmt::Special);
    } else if wants("float") && FLOAT_EXP.is_match(&text) {
        scalar.val = Val::Num(text.trim_start_matches('+').parse::<f64>().unwrap_or(f64::NAN), Fmt::Exp);
    } else if wants("float") && FLOAT.is_match(&text) {
        let n = text.trim_start_matches('+').parse::<f64>().unwrap_or(f64::NAN);
        let min = match text.find('.') {
            Some(dot) if text.ends_with('0') => text.len() - dot - 1,
            _ => 0,
        };
        scalar.val = Val::Num(n, Fmt::Float(min));
    }
}

// ---------------------------------------------------------------------------------------------
// Printing.

/// The stringify context: the scalar printer's plus the collection state.
#[derive(Clone)]
struct Fc {
    s: Ctx,
    all_null_values: bool,
}

fn indent_comment(comment: &str, indent: &str) -> String {
    if !comment.is_empty() && comment.chars().all(|c| c == '\n') {
        return comment[1..].to_owned();
    }
    if indent.is_empty() {
        return comment.to_owned();
    }
    comment
        .split('\n')
        .map(|line| if line.chars().all(|c| c == ' ') { line.to_owned() } else { format!("{indent}{line}") })
        .collect::<Vec<_>>()
        .join("\n")
}

fn line_comment(text: &str, indent: &str, comment: &str) -> String {
    if text.ends_with('\n') {
        indent_comment(comment, indent)
    } else if comment.contains('\n') {
        format!("\n{}", indent_comment(comment, indent))
    } else {
        format!("{}{comment}", if text.ends_with(' ') { "" } else { " " })
    }
}

fn number_text(n: f64, fmt: Option<Fmt>, min_fraction: usize) -> String {
    if n.is_nan() {
        return ".nan".to_owned();
    }
    if n.is_infinite() {
        return if n < 0.0 { "-.inf" } else { ".inf" }.to_owned();
    }
    let mut text = if n == 0.0 && n.is_sign_negative() { "-0".to_owned() } else { number_to_string(n) };
    let digit_start = text.strip_prefix('-').unwrap_or(&text).starts_with(|c: char| c.is_ascii_digit());
    if fmt.is_none() && min_fraction > 0 && digit_start && !text.contains('e') {
        let dot = text.find('.').unwrap_or_else(|| {
            let at = text.len();
            text.push('.');
            at
        });
        let have = text.len() - dot - 1;
        text.push_str(&"0".repeat(min_fraction.saturating_sub(have)));
    }
    text
}

/// A scalar node's text by its value and tag (`tagObj.stringify`).
fn scalar_text(node: &Node, scalar: &Scalar, comment: Option<&str>, ctx: &Fc) -> Result<(String, bool), SkillDocumentError> {
    let s = &ctx.s;
    Ok(match &scalar.val {
        Val::Str(text) => tagged_string(text, scalar.kind, comment, node.tag.as_deref(), &scalar.source, s)?,
        Val::Null => (if NULL.is_match(&scalar.source) { scalar.source.clone() } else { "null".to_owned() }, false),
        Val::Bool => (scalar.source.clone(), false),
        Val::Num(n, fmt) => {
            let radix = |prefix: &str, radix: u32| {
                if n.is_finite() && *n >= 0.0 && n.fract() == 0.0 {
                    let digits = match radix {
                        8 => format!("{:o}", *n as u128),
                        _ => format!("{:x}", *n as u128),
                    };
                    format!("{prefix}{digits}")
                } else {
                    number_text(*n, None, 0)
                }
            };
            let text = match fmt {
                Fmt::Dec | Fmt::Special => number_text(*n, None, 0),
                Fmt::Oct => radix("0o", 8),
                Fmt::Hex => radix("0x", 16),
                Fmt::Exp if n.is_finite() => to_exponential(*n),
                Fmt::Exp => number_text(*n, Some(Fmt::Exp), 0),
                Fmt::Float(min) => number_text(*n, None, *min),
            };
            (text, false)
        }
    })
}

fn stringify_node(node: &Node, ctx: &Fc) -> Result<String, SkillDocumentError> {
    if let Body::Alias(name) = &node.body {
        return Ok(format!("*{name}{}", if ctx.s.implicit_key { " " } else { "" }));
    }
    let props = props_text(node.anchor.as_deref(), node.tag.as_deref());
    let mut ctx = ctx.clone();
    if !props.is_empty() {
        ctx.s.indent_at_start = Some(ctx.s.indent_at_start.unwrap_or(0) + utf16_len(&props) + 1);
    }
    let text = match &node.body {
        Body::Scalar(scalar) => scalar_text(node, scalar, None, &ctx)?.0,
        Body::Map(_) | Body::Seq(_) => stringify_collection(node, &ctx)?,
        Body::Alias(_) => String::new(),
    };
    if props.is_empty() {
        return Ok(text);
    }
    Ok(if node.is_scalar() || text.starts_with(['{', '[']) { format!("{props} {text}") } else { format!("{props}\n{}{text}", ctx.s.indent) })
}

fn add_comment_before(ctx: &Fc, lines: &mut Vec<String>, comment: Option<&str>) {
    if let Some(comment) = comment {
        let printed = indent_comment(&comment_string(comment), &ctx.s.indent);
        lines.push(printed.trim_start().to_owned());
    }
}

fn stringify_collection(node: &Node, ctx: &Fc) -> Result<String, SkillDocumentError> {
    let (items, start, end, base): (Vec<Item>, &str, &str, String) = match &node.body {
        Body::Map(pairs) => (pairs.iter().cloned().map(Item::Pair).collect(), "{", "}", ctx.s.indent.clone()),
        Body::Seq(items) => (items.clone(), "[", "]", format!("{}  ", ctx.s.indent)),
        _ => return Ok(String::new()),
    };
    let all_null = ctx.all_null_values
        || matches!(&node.body, Body::Map(pairs) if !pairs.is_empty() && pairs.iter().all(|p| p.value.is_none()));
    let item_indent = format!("{base}{STEP}");
    let item_ctx = Fc { s: Ctx { indent: item_indent.clone(), in_flow: true, ..ctx.s.clone() }, all_null_values: all_null };
    let mut required_newline = false;
    let mut lines_at_value = 0;
    let mut lines: Vec<String> = Vec::new();
    for (n, item) in items.iter().enumerate() {
        let mut comment: Option<String> = None;
        match item {
            Item::Node(node) => {
                if node.space_before {
                    lines.push(String::new());
                }
                add_comment_before(ctx, &mut lines, node.comment_before.as_deref());
                comment = node.comment.clone();
            }
            Item::Pair(pair) => {
                if let Some(key) = &pair.key {
                    if key.space_before {
                        lines.push(String::new());
                    }
                    add_comment_before(ctx, &mut lines, key.comment_before.as_deref());
                    if key.comment.is_some() {
                        required_newline = true;
                    }
                }
                match &pair.value {
                    Some(value) => {
                        if value.comment.is_some() {
                            comment = value.comment.clone();
                        }
                        if value.comment_before.is_some() {
                            required_newline = true;
                        }
                    }
                    None => {
                        if let Some(key_comment) = pair.key.as_ref().and_then(|k| k.comment.clone()) {
                            comment = Some(key_comment);
                        }
                    }
                }
            }
        }
        if comment.is_some() {
            required_newline = true;
        }
        let mut text = match item {
            Item::Node(node) => stringify_node(node, &item_ctx)?,
            Item::Pair(pair) => stringify_pair(pair, &item_ctx)?,
        };
        required_newline = required_newline || lines.len() > lines_at_value || text.contains('\n');
        if n + 1 < items.len() {
            text.push(',');
        }
        if let Some(comment) = comment {
            text.push_str(&line_comment(&text, &item_ctx.s.indent, &comment_string(&comment)));
        }
        lines.push(text);
        lines_at_value = lines.len();
    }
    if lines.is_empty() {
        return Ok(format!("{start}{end}"));
    }
    if !required_newline {
        let len = lines.iter().fold(2, |sum, line| sum + utf16_len(line) + 2);
        required_newline = len > LINE_WIDTH;
    }
    if required_newline {
        let mut out = start.to_owned();
        for line in &lines {
            if line.is_empty() {
                out.push('\n');
            } else {
                out.push_str(&format!("\n{STEP}{}{line}", ctx.s.indent));
            }
        }
        return Ok(format!("{out}\n{}{end}", ctx.s.indent));
    }
    Ok(format!("{start} {} {end}", lines.join(" ")))
}

fn stringify_pair(pair: &Pair, ctx: &Fc) -> Result<String, SkillDocumentError> {
    let key_comment = pair.key.as_ref().and_then(|k| k.comment.clone());
    let explicit_key = match &pair.key {
        None => true,
        Some(key) => key.is_collection() || matches!(&key.body, Body::Scalar(s) if matches!(s.kind, Kind::Literal | Kind::Folded)),
    };
    let all_null = ctx.all_null_values;
    let mut key_ctx = Fc { s: ctx.s.clone(), all_null_values: false };
    key_ctx.s.implicit_key = !explicit_key && !all_null;
    key_ctx.s.indent = format!("{}{STEP}", ctx.s.indent);
    let key_node = pair.key.clone().unwrap_or_else(|| Node::new(Body::Scalar(Scalar { val: Val::Null, kind: Kind::Plain, source: String::new() })));
    let mut text = stringify_node(&key_node, &key_ctx)?;
    if pair.value.is_none() || all_null {
        return Ok(if text.is_empty() {
            "?".to_owned()
        } else if explicit_key {
            format!("? {text}")
        } else {
            text
        });
    }
    let indent = &ctx.s.indent;
    if explicit_key {
        if let Some(comment) = &key_comment {
            text.push_str(&line_comment(&text, &key_ctx.s.indent, &comment_string(comment)));
        }
        text = format!("? {text}\n{indent}:");
    } else {
        text.push(':');
        if let Some(comment) = &key_comment {
            text.push_str(&line_comment(&text, &key_ctx.s.indent, &comment_string(comment)));
        }
    }
    let Some(value) = &pair.value else { return Ok(text) };
    let (space_before, comment_before) = if value.raw { (false, None) } else { (value.space_before, value.comment_before.clone()) };
    let mut value_ctx = key_ctx.clone();
    value_ctx.s.implicit_key = false;
    if !explicit_key && key_comment.is_none() && value.is_scalar() && !value.raw {
        value_ctx.s.indent_at_start = Some(utf16_len(&text) + 1);
    }
    let value_text = stringify_node(value, &value_ctx)?;
    let mut ws = " ".to_owned();
    if key_comment.is_some() || space_before || comment_before.is_some() {
        ws = if space_before { "\n" } else { "" }.to_owned();
        if let Some(comment) = &comment_before {
            ws.push_str(&format!("\n{}", indent_comment(&comment_string(comment), &value_ctx.s.indent)));
        }
        if value_text.is_empty() {
            if ws == "\n" && value.comment.is_some() {
                ws = "\n\n".to_owned();
            }
        } else {
            ws.push_str(&format!("\n{}", value_ctx.s.indent));
        }
    } else if !explicit_key && value.is_collection() {
        if value_text.contains('\n') {
            ws = format!("\n{}", value_ctx.s.indent);
        }
    } else if value_text.is_empty() || value_text.starts_with('\n') {
        ws.clear();
    }
    text.push_str(&ws);
    text.push_str(&value_text);
    Ok(text)
}

// ---------------------------------------------------------------------------------------------
// The document.

/// Parses `front` (a flow mapping), sets name, description and trigger the way `document.set`
/// and `document.delete` do, and prints the document.
pub(crate) fn print_flow_document(front: &str, wanted: &[(&str, Option<&String>); 3]) -> Result<String, SkillDocumentError> {
    let mut parser = Parser { c: front.chars().collect(), i: 0 };
    let head = parser.gap();
    let mut root = parser.node()?;
    let tail = parser.gap();
    if parser.peek().is_some() {
        return Err(invalid("unexpected text after the mapping"));
    }
    let Body::Map(pairs) = &mut root.body else { return Err(SkillDocumentError::NotMapping) };
    for (key, value) in wanted {
        let position = pairs.iter().position(|p| {
            p.key.as_ref().is_some_and(|k| matches!(&k.body, Body::Scalar(Scalar { val: Val::Str(text), .. }) if text == key))
        });
        match (position, value) {
            (Some(at), Some(text)) => {
                let slot = &mut pairs[at].value;
                match slot {
                    Some(Node { body: Body::Scalar(scalar), .. }) => scalar.val = Val::Str((*text).clone()),
                    _ => *slot = Some(Node::raw_string(text)),
                }
            }
            (None, Some(text)) => pairs.push(Pair { key: Some(Node::raw_string(key)), value: Some(Node::raw_string(text)) }),
            (Some(at), None) => {
                pairs.remove(at);
            }
            (None, None) => {}
        }
    }
    let ctx = Fc { s: Ctx { indent: String::new(), in_flow: false, implicit_key: false, indent_at_start: None }, all_null_values: false };
    let mut body = stringify_node(&root, &ctx)?;
    let mut lines: Vec<String> = Vec::new();
    // Comments in front of the mapping: attached ones precede it directly, others stand apart.
    let leading: Vec<String> = head.comments.iter().map(|(t, _)| t.clone()).collect();
    if !leading.is_empty() {
        lines.push(comment_string(&leading.join("\n")));
        if head.blank_line {
            lines.push(String::new());
        }
    }
    if let Some((text, _)) = tail.comments.iter().find(|(_, same_line)| *same_line) {
        body.push_str(&line_comment(&body, "", &comment_string(text)));
    }
    lines.push(body);
    let own: Vec<String> = tail.comments.iter().filter(|(_, same)| !*same).map(|(t, _)| t.clone()).collect();
    if !own.is_empty() {
        lines.push(String::new());
        lines.push(comment_string(&own.join("\n")));
    }
    Ok(lines.join("\n"))
}
