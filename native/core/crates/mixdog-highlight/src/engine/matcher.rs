//! `MultiRegex` and `ResumableMultiRegex` of core.js, over `regress` with JavaScript `lastIndex` semantics.
//!
//! One regular expression per matcher: every rule of a mode wrapped in a group and joined by `|`; the group
//! that took part says which rule matched. The text is UTF-16 code units, as JavaScript indexes it.

use std::cell::{Cell, OnceCell, RefCell};
use std::ops::Range;
use std::rc::Rc;

use regress::{Flags, Regex};

/// What a rule of a mode's matcher stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuleKind {
    /// The `begin` of the contained mode with this index.
    Begin(usize),
    End,
    Illegal,
}

/// A regular expression compiled on first use, with the flags `langRe` gives: `m`, plus `i` for a
/// case-insensitive language. `None` when it does not compile.
#[derive(Debug)]
pub(crate) struct LazyRegex {
    source: String,
    icase: bool,
    compiled: OnceCell<Option<Regex>>,
}

impl LazyRegex {
    pub(crate) fn new(source: String, icase: bool) -> Self {
        Self { source, icase, compiled: OnceCell::new() }
    }

    /// `escape(value)` of core.js: the text as a literal pattern, with the `m` flag only.
    pub(crate) fn escaped(text: &[u16]) -> Self {
        let mut out = String::with_capacity(text.len());
        for unit in char::decode_utf16(text.iter().copied()) {
            match unit {
                Ok(c) => {
                    if "-/\\^$*+?.()|[]{}".contains(c) {
                        out.push('\\');
                    }
                    out.push(c);
                }
                // A lone surrogate cannot be written in a Rust pattern; no definition has one.
                Err(_) => out.push('\u{FFFD}'),
            }
        }
        Self::new(out, false)
    }

    pub(crate) fn get(&self) -> Option<&Regex> {
        self.compiled
            .get_or_init(|| {
                let flags = Flags { icase: self.icase, multiline: true, ..Flags::default() };
                Regex::with_flags(&engine_source(&self.source, self.icase), flags).ok()
            })
            .as_ref()
    }

    /// First match at or after `start`, as `RegExp.prototype.exec` with `lastIndex = start` finds it.
    pub(crate) fn find_from(&self, text: &[u16], start: usize) -> Option<regress::Match> {
        if start > text.len() {
            return None;
        }
        self.get()?.find_from_utf16(text, start).next()
    }
}

/// A rule of a matcher. `position` is shared by every `MultiRegex` built from the matcher, and each build
/// rewrites it (core.js stores it on the `opts` object all of them share).
#[derive(Debug)]
pub(crate) struct Rule {
    pub(crate) pattern: String,
    pub(crate) kind: RuleKind,
    position: Cell<usize>,
}

/// A match with the rule that produced it, as `MultiRegex.exec` returns it.
#[derive(Debug)]
pub(crate) struct LexMatch {
    /// Start of the match in the text (`match.index`).
    pub(crate) index: usize,
    /// End of the match (`index + lexeme.length`).
    pub(crate) end: usize,
    pub(crate) kind: RuleKind,
    pub(crate) position: usize,
    base: usize,
    caps: regress::Match,
}

impl LexMatch {
    /// `match[k]` once the groups before the rule's own were trimmed off: 0 is the lexeme.
    pub(crate) fn group(&self, k: usize) -> Option<Range<usize>> {
        self.caps.group(self.base + k)
    }
}

/// One compiled alternation of the rules from some index on.
#[derive(Debug)]
struct MultiRegex {
    /// `None` with `broken` false: no rules, nothing ever matches. `None` with `broken` true: the alternation
    /// does not compile (core.js would throw when it is built).
    regex: Option<Regex>,
    broken: bool,
    /// `(group index of the rule's wrapper, rule index)`.
    match_indexes: Vec<(usize, usize)>,
}

impl MultiRegex {
    fn exec(&self, rules: &[Rule], text: &[u16], last_index: usize) -> Result<Option<LexMatch>, ()> {
        if self.broken {
            return Err(());
        }
        let Some(regex) = self.regex.as_ref() else {
            return Ok(None);
        };
        if last_index > text.len() {
            return Ok(None);
        }
        let Some(found) = regex.find_from_utf16(text, last_index).next() else {
            return Ok(None);
        };
        let Some(base) = (1..=found.captures.len()).find(|&g| found.group(g).is_some()) else {
            return Err(());
        };
        let Some(&(_, rule_index)) = self.match_indexes.iter().find(|(group, _)| *group == base) else {
            return Err(());
        };
        let rule = &rules[rule_index];
        Ok(Some(LexMatch { index: found.start(), end: found.end(), kind: rule.kind, position: rule.position.get(), base, caps: found }))
    }
}

/// Everything a mode's `ResumableMultiRegex` holds.
#[derive(Debug)]
pub(crate) struct Matcher {
    rules: Vec<Rule>,
    /// How many rules are `begin` rules.
    count: usize,
    icase: bool,
    multi: RefCell<Vec<Option<Rc<MultiRegex>>>>,
    pub(crate) last_index: Cell<usize>,
    pub(crate) regex_index: Cell<usize>,
}

impl Matcher {
    pub(crate) fn new(rules: Vec<(String, RuleKind)>, icase: bool) -> Self {
        let count = rules.iter().filter(|(_, kind)| matches!(kind, RuleKind::Begin(_))).count();
        let rules: Vec<Rule> = rules.into_iter().map(|(pattern, kind)| Rule { pattern, kind, position: Cell::new(0) }).collect();
        let slots = vec![None; rules.len() + 1];
        Self { rules, count, icase, multi: RefCell::new(slots), last_index: Cell::new(0), regex_index: Cell::new(0) }
    }

    pub(crate) fn consider_all(&self) {
        self.regex_index.set(0);
    }

    pub(crate) fn resuming_scan_at_same_position(&self) -> bool {
        self.regex_index.get() != 0
    }

    /// `getMatcher(index)`: the alternation of the rules from `index` on, built once.
    fn matcher_from(&self, index: usize) -> Rc<MultiRegex> {
        if let Some(Some(built)) = self.multi.borrow().get(index) {
            return built.clone();
        }
        let mut position = 0;
        let mut match_at = 1;
        let mut match_indexes = Vec::new();
        let mut patterns: Vec<&str> = Vec::new();
        for (rule_index, rule) in self.rules.iter().enumerate().skip(index) {
            rule.position.set(position);
            position += 1;
            match_indexes.push((match_at, rule_index));
            match_at += count_groups(&rule.pattern) + 1;
            patterns.push(&rule.pattern);
        }
        let (regex, broken) = if patterns.is_empty() {
            (None, false)
        } else {
            let flags = Flags { icase: self.icase, multiline: true, ..Flags::default() };
            match Regex::with_flags(&engine_source(&join(&patterns), self.icase), flags) {
                Ok(regex) => (Some(regex), false),
                Err(_) => (None, true),
            }
        };
        let built = Rc::new(MultiRegex { regex, broken, match_indexes });
        if let Some(slot) = self.multi.borrow_mut().get_mut(index) {
            *slot = Some(built.clone());
        }
        built
    }

    /// Whether the alternation of every suffix of the rules compiles (the tests check this for each carried language).
    #[cfg(test)]
    pub(crate) fn every_alternation_compiles(&self) -> bool {
        (0..=self.rules.len()).all(|index| !self.matcher_from(index).broken)
    }

    /// `ResumableMultiRegex.exec`; `Err` when an alternation does not compile.
    pub(crate) fn exec(&self, text: &[u16]) -> Result<Option<LexMatch>, ()> {
        let last_index = self.last_index.get();
        let first = self.matcher_from(self.regex_index.get());
        let mut result = first.exec(&self.rules, text, last_index)?;
        if self.resuming_scan_at_same_position() {
            let same_place = result.as_ref().is_some_and(|r| r.index == last_index);
            if !same_place {
                result = self.matcher_from(0).exec(&self.rules, text, last_index + 1)?;
            }
        }
        if let Some(found) = &result {
            self.regex_index.set(self.regex_index.get() + found.position + 1);
            if self.regex_index.get() == self.count {
                self.consider_all();
            }
        }
        Ok(result)
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `countMatchGroups`: how many capture groups a pattern has.
pub(crate) fn count_groups(source: &str) -> usize {
    let chars: Vec<char> = source.chars().collect();
    let mut i = 0;
    let mut groups = 0;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 2,
            '[' => {
                i += 1;
                while i < chars.len() && chars[i] != ']' {
                    if chars[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
            }
            '(' => {
                if chars.get(i + 1) == Some(&'?') {
                    let named = chars.get(i + 2) == Some(&'<') && !matches!(chars.get(i + 3), Some(&'=') | Some(&'!'));
                    if named {
                        groups += 1;
                    }
                } else {
                    groups += 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    groups
}

/// A token of `BACKREF_RE` (`\[(?:[^\\\]]|\\.)*\]|\(\??|\\([1-9][0-9]*)|\\.`): where it starts, its length, what it is.
enum Token {
    /// A `[...]` class or an escape: copied as it is.
    Plain,
    /// `(` or `(?`; true when it is `(`, which captures.
    Paren(bool),
    BackRef(usize),
}

fn next_token(chars: &[char], from: usize) -> Option<(usize, usize, Token)> {
    let mut i = from;
    while i < chars.len() {
        match chars[i] {
            '[' => {
                let mut j = i + 1;
                let mut closed = false;
                while j < chars.len() {
                    match chars[j] {
                        ']' => {
                            closed = true;
                            break;
                        }
                        '\\' => {
                            if j + 1 < chars.len() && !is_line_terminator(chars[j + 1]) {
                                j += 2;
                            } else {
                                break;
                            }
                        }
                        _ => j += 1,
                    }
                }
                if closed {
                    return Some((i, j + 1 - i, Token::Plain));
                }
            }
            '(' => {
                return Some(if chars.get(i + 1) == Some(&'?') { (i, 2, Token::Paren(false)) } else { (i, 1, Token::Paren(true)) });
            }
            '\\' => {
                if let Some(&next) = chars.get(i + 1) {
                    if ('1'..='9').contains(&next) {
                        let mut j = i + 2;
                        while j < chars.len() && chars[j].is_ascii_digit() {
                            j += 1;
                        }
                        let number: String = chars[i + 1..j].iter().collect();
                        return Some((i, j - i, Token::BackRef(number.parse().unwrap_or(0))));
                    }
                    if !is_line_terminator(next) {
                        return Some((i, 2, Token::Plain));
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The pattern as the engine must be given it. In a case-insensitive pattern regress folds the long s and the Kelvin
/// sign into `s` and `k` even without the `u` flag (JavaScript keeps a non-ASCII character apart from an ASCII one),
/// so a negated class that holds `\W` leaves out the letters `s` and `k` (`[^\W:= ]` would not match `else`). The
/// word characters that are not in such a class are written as `(?:(?![members])\w)`.
fn engine_source(source: &str, icase: bool) -> String {
    if !icase || !source.contains("\\W") {
        return source.to_owned();
    }
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len() + 16);
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '\\' => {
                out.push('\\');
                if let Some(next) = chars.get(at + 1) {
                    out.push(*next);
                }
                at += 2;
            }
            '[' => {
                let negated = chars.get(at + 1) == Some(&'^');
                let mut end = at + 1 + usize::from(negated);
                let body_start = end;
                while end < chars.len() && chars[end] != ']' {
                    end += if chars[end] == '\\' { 2 } else { 1 };
                }
                let end = end.min(chars.len());
                let body = &chars[body_start..end];
                let (members, has_word_negation) = class_members(body);
                if negated && has_word_negation && end < chars.len() {
                    if members.is_empty() {
                        out.push_str("(?:\\w)");
                    } else {
                        out.push_str("(?:(?![");
                        out.push_str(&members);
                        out.push_str("])\\w)");
                    }
                } else {
                    out.extend(&chars[at..(end + 1).min(chars.len())]);
                }
                at = end + 1;
            }
            c => {
                out.push(c);
                at += 1;
            }
        }
    }
    out
}

/// The members of a character class body without its `\\W` escapes, and whether it held one.
fn class_members(body: &[char]) -> (String, bool) {
    let mut members = String::new();
    let mut has_word_negation = false;
    let mut k = 0;
    while k < body.len() {
        if body[k] == '\\' {
            if body.get(k + 1) == Some(&'W') {
                has_word_negation = true;
            } else {
                members.push('\\');
                members.extend(body.get(k + 1));
            }
            k += 2;
        } else {
            members.push(body[k]);
            k += 1;
        }
    }
    (members, has_word_negation)
}

/// `join(regexps, "|")` of core.js: each pattern in its own group, back-references renumbered.
pub(crate) fn join(patterns: &[&str]) -> String {
    let mut captures = 0usize;
    let mut parts = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        captures += 1;
        let offset = captures;
        let chars: Vec<char> = pattern.chars().collect();
        let mut out = String::with_capacity(pattern.len() + 8);
        let mut at = 0;
        while let Some((start, len, token)) = next_token(&chars, at) {
            out.extend(&chars[at..start]);
            at = start + len;
            match token {
                Token::BackRef(n) => {
                    out.push('\\');
                    out.push_str(&(n + offset).to_string());
                }
                Token::Paren(captures_group) => {
                    out.extend(&chars[start..start + len]);
                    if captures_group {
                        captures += 1;
                    }
                }
                Token::Plain => out.extend(&chars[start..start + len]),
            }
        }
        out.extend(&chars[at..]);
        parts.push(format!("({out})"));
    }
    parts.join("|")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn a_negated_class_with_the_word_negation_keeps_s_and_k() {
        assert_eq!(engine_source("[^\\W:= ]", true), "(?:(?![:= ])\\w)");
        assert_eq!(engine_source("[^\\W]", true), "(?:\\w)");
        assert_eq!(engine_source("[^\\W:= ]", false), "[^\\W:= ]");
        assert_eq!(engine_source("a\\[^\\W]", true), "a\\[^\\W]");
        assert_eq!(engine_source("[\\W]x", true), "[\\W]x");
        let re = Regex::with_flags(&engine_source("([^\\\\\\W:= ]|\\\\.)+ ", true), Flags { icase: true, ..Flags::default() }).unwrap();
        assert_eq!(re.find("else ").map(|m| m.range()), Some(0..5));
    }

    #[test]
    fn counts_capture_groups_like_javascript() {
        assert_eq!(count_groups("a(b)(?:c)(?=d)(?<!e)(?<name>f)"), 2);
        assert_eq!(count_groups(r"\(x\)[(](y)"), 1);
        assert_eq!(count_groups(r"[^\]](a)"), 1);
        assert_eq!(count_groups(""), 0);
    }

    #[test]
    fn join_wraps_each_rule_and_renumbers_back_references() {
        assert_eq!(join(&["a", "b"]), "(a)|(b)");
        assert_eq!(join(&[r"(x)\1", r"(y)\1"]), r"((x)\2)|((y)\4)");
        assert_eq!(join(&[r"[(]\1", "(?:q)"]), r"([(]\2)|((?:q))");
    }

    #[test]
    fn the_matching_group_names_the_rule() {
        let matcher =
            Matcher::new(vec![("a+".to_string(), RuleKind::Begin(7)), (r"(b)(c)".to_string(), RuleKind::End), ("\\d".to_string(), RuleKind::Illegal)], false);
        let text = utf16("xxbc9");
        matcher.consider_all();
        matcher.last_index.set(0);
        let m = matcher.exec(&text).expect("compiles").expect("a match");
        assert_eq!((m.index, m.end, m.kind), (2, 4, RuleKind::End));
        assert_eq!(m.group(1), Some(2..3));
        assert_eq!(m.group(2), Some(3..4));
    }

    #[test]
    fn a_resumed_scan_skips_the_rules_before_the_one_that_matched() {
        let matcher = Matcher::new(vec![("x".to_string(), RuleKind::Begin(1)), ("x|y".to_string(), RuleKind::Begin(2))], false);
        let text = utf16("xy");
        matcher.consider_all();
        matcher.last_index.set(0);
        let first = matcher.exec(&text).expect("compiles").expect("first");
        assert_eq!(first.kind, RuleKind::Begin(1));
        // The first rule was ignored at index 0: scanning resumes with the second only.
        assert!(matcher.resuming_scan_at_same_position());
        matcher.last_index.set(0);
        let second = matcher.exec(&text).expect("compiles").expect("second");
        assert_eq!((second.index, second.kind), (0, RuleKind::Begin(2)));
    }

    #[test]
    fn an_empty_rule_list_matches_nothing() {
        let matcher = Matcher::new(Vec::new(), false);
        assert!(matcher.exec(&utf16("abc")).expect("compiles").is_none());
    }

    #[test]
    fn escaped_text_is_a_literal_pattern() {
        let re = LazyRegex::escaped(&utf16("a.b(c"));
        assert!(re.find_from(&utf16("xa.b(c"), 0).is_some());
        assert!(re.find_from(&utf16("xaxb(c"), 0).is_none());
    }
}
