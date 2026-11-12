//! A pattern with JavaScript semantics (`regress`): `\s` is the full ECMAScript white-space set
//! (including U+00A0, U+FEFF and the line separators), `\w`, `\d` and `\b` are ASCII without the
//! `u` flag, `.` stops at every line terminator. Offsets are byte offsets into the searched
//! `&str`.

use std::ops::Range;

use crate::regex_error::js_regex_error;

pub struct JsRegex(regress::Regex, Option<Needles>);

/// Strings one of which every match of a pattern contains, read from the pattern: a long text that holds none of them has
/// no match, which is answered without the engine. The engine starts a match attempt at every position of the text
/// (about a third of a microsecond each for a pattern that begins with an assertion, an alternation or a class), so a
/// shell command of 5 MiB took 24 s in the shell tool's checks; containment is a scan of the text.
///
/// The strings are derived from the pattern's syntax by [`Reader`], never written by hand: a literal character, a small
/// class of literal characters, a group or alternation of those, and a quantified one repeated at least once are
/// followed; anything else is a part that requires nothing, and a construct the reader does not know exactly (an escape
/// other than `\b \B \d \D \w \W \s \S \n \r \t \f \v` and identity escapes of punctuation, `(?` forms other than groups
/// and look-arounds) leaves the pattern without strings, so it is never skipped. Patterns with the `u` or `v` flag
/// (Unicode case folding and syntax) have none either.
struct Needles {
    strings: Vec<String>,
    /// The `i` flag: the strings are ASCII and lowercase. The engine (regress, without `u`) matches a character to a
    /// pattern character when their simple uppercase mappings are equal (`unicode::fold_code_point`), and inside a class
    /// also through Unicode simple case folding: an ASCII character matches only the two ASCII cases of itself, while a
    /// non-ASCII one may match an ASCII letter (`ı` an `i`, `ſ` an `s`, the Kelvin sign a `k`). So the text is read
    /// with its ASCII letters lowercased and every non-ASCII character standing for any character of a string: a
    /// superset of the engine's rule, never a narrower one.
    fold: bool,
}

/// A non-ASCII character of the text, which [`Needles`] with `fold` lets stand for any (ASCII) character of a string.
const ANY_CHARACTER: u8 = 0x80;

/// Texts shorter than this are searched by the engine alone: the check would cost more than it saves.
const NEEDLES_FROM: usize = 64 * 1024;
/// The most strings a set of alternatives or a cross product of them is kept to.
const NEEDLES_MAX: usize = 64;

/// What a part of a pattern says about the text it matches.
enum Lit {
    /// The match is one of these strings.
    Exact(Vec<String>),
    /// The match contains one of these strings, none empty.
    Inner(Vec<String>),
    /// Nothing that is followed here.
    Any,
}

fn exact(text: &str) -> Lit {
    Lit::Exact(vec![text.to_owned()])
}

/// The requirement a part keeps when it may be repeated or is joined to parts not known exactly.
fn required(lit: Lit) -> Option<Vec<String>> {
    match lit {
        Lit::Exact(set) | Lit::Inner(set) if set.iter().all(|s| !s.is_empty()) => Some(set),
        _ => None,
    }
}

/// The longest-shortest of the sets: the one whose shortest string is longest, the smaller on a tie.
fn best(candidates: Vec<Vec<String>>) -> Option<Vec<String>> {
    let shortest = |set: &Vec<String>| set.iter().map(String::len).min().unwrap_or(0);
    candidates
        .into_iter()
        .filter(|set| shortest(set) > 0)
        .max_by(|a, b| shortest(a).cmp(&shortest(b)).then(b.len().cmp(&a.len())))
}

fn concat(parts: Vec<Lit>) -> Lit {
    let mut run = vec![String::new()];
    let mut candidates = Vec::new();
    let mut whole = true;
    for part in parts {
        match part {
            Lit::Exact(set) if run.len() * set.len() <= NEEDLES_MAX => {
                run = run.iter().flat_map(|head| set.iter().map(move |tail| format!("{head}{tail}"))).collect();
            }
            Lit::Exact(set) => {
                candidates.push(std::mem::replace(&mut run, set));
                whole = false;
            }
            other => {
                candidates.push(std::mem::replace(&mut run, vec![String::new()]));
                candidates.extend(required(other));
                whole = false;
            }
        }
    }
    if whole {
        return Lit::Exact(run);
    }
    candidates.push(run);
    best(candidates).map_or(Lit::Any, Lit::Inner)
}

fn union(branches: Vec<Lit>) -> Lit {
    if branches.iter().all(|b| matches!(b, Lit::Exact(_))) {
        let mut all: Vec<String> = branches.into_iter().flat_map(|b| if let Lit::Exact(set) = b { set } else { Vec::new() }).collect();
        all.sort();
        all.dedup();
        return if all.len() <= NEEDLES_MAX { Lit::Exact(all) } else { required(Lit::Exact(all)).map_or(Lit::Any, Lit::Inner) };
    }
    let mut all = Vec::new();
    for branch in branches {
        let Some(set) = required(branch) else { return Lit::Any };
        all.extend(set);
    }
    all.sort();
    all.dedup();
    if all.len() <= NEEDLES_MAX { Lit::Inner(all) } else { Lit::Any }
}

/// A reading of the pattern (without `u` or `v`, Annex B) that follows literals, groups, alternatives, quantifiers and
/// small classes; whatever else it meets is `Any`, and syntax it does not expect ends the reading with `None`.
struct Reader {
    chars: Vec<char>,
    at: usize,
}

impl Reader {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.at += 1;
        Some(c)
    }

    fn eat(&mut self, text: &str) -> bool {
        let wanted: Vec<char> = text.chars().collect();
        if self.chars[self.at..].starts_with(&wanted) {
            self.at += wanted.len();
            return true;
        }
        false
    }

    fn alternation(&mut self) -> Option<Lit> {
        let mut branches = vec![self.sequence()?];
        while self.peek() == Some('|') {
            self.at += 1;
            branches.push(self.sequence()?);
        }
        Some(if branches.len() == 1 { branches.pop()? } else { union(branches) })
    }

    fn sequence(&mut self) -> Option<Lit> {
        let mut parts = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.atom()?;
            parts.push(self.quantified(atom));
        }
        Some(concat(parts))
    }

    /// `{n}`, `{n,}` or `{n,m}` at the reader: its `n`, consumed; anything else (a literal brace) is left.
    fn braces(&mut self) -> Option<usize> {
        let start = self.at;
        self.at += 1;
        let digits = |reader: &mut Self| {
            let from = reader.at;
            while reader.peek().is_some_and(|c| c.is_ascii_digit()) {
                reader.at += 1;
            }
            (reader.at > from).then(|| reader.chars[from..reader.at].iter().collect::<String>())
        };
        let parsed = (|| {
            let min = digits(self)?;
            if self.peek() == Some(',') {
                self.at += 1;
                let _ = digits(self);
            }
            (self.next()? == '}').then_some(min.parse::<usize>().unwrap_or(usize::MAX))
        })();
        if parsed.is_none() {
            self.at = start;
        }
        parsed
    }

    fn quantified(&mut self, atom: Lit) -> Lit {
        let min = match self.peek() {
            Some('*' | '?') => {
                self.at += 1;
                0
            }
            Some('+') => {
                self.at += 1;
                1
            }
            Some('{') => match self.braces() {
                Some(min) => min,
                None => return atom,
            },
            _ => return atom,
        };
        if self.peek() == Some('?') {
            self.at += 1;
        }
        if min == 0 { Lit::Any } else { required(atom).map_or(Lit::Any, Lit::Inner) }
    }

    fn atom(&mut self) -> Option<Lit> {
        Some(match self.next()? {
            '^' | '$' => exact(""),
            '.' | '{' => Lit::Any,
            '(' => {
                let zero_width = if self.eat("?=") || self.eat("?!") || self.eat("?<=") || self.eat("?<!") {
                    true
                } else if self.eat("?<") {
                    while self.next()? != '>' {}
                    false
                } else if self.eat("?:") {
                    false
                } else if self.peek() == Some('?') {
                    return None;
                } else {
                    false
                };
                let inner = self.alternation()?;
                if self.next()? != ')' {
                    return None;
                }
                if zero_width { exact("") } else { inner }
            }
            '[' => self.class()?,
            '\\' => match self.next()? {
                'b' | 'B' => exact(""),
                'n' => exact("\n"),
                'r' => exact("\r"),
                't' => exact("\t"),
                'f' => exact("\u{c}"),
                'v' => exact("\u{b}"),
                // One character of a class.
                'd' | 'D' | 'w' | 'W' | 's' | 'S' => Lit::Any,
                // Back references and code escapes (`\1`, `\k<n>`, `\x41`, `\u0041`, `\cA`) span characters the reader
                // does not count, and Annex B reads some of them as letters: the pattern gets no strings.
                c if c.is_ascii_alphanumeric() => return None,
                c => exact(&c.to_string()),
            },
            '*' | '+' | '?' | ')' | '|' => return None,
            c => exact(&c.to_string()),
        })
    }

    /// A class of a few plain characters is their set; a negated one, a range or an escaped class is `Any`.
    fn class(&mut self) -> Option<Lit> {
        let mut known = !self.eat("^");
        let mut chars = Vec::new();
        loop {
            match self.next()? {
                ']' => break,
                '\\' => match self.next()? {
                    c if c.is_ascii_alphanumeric() => known = false,
                    c => chars.push(c),
                },
                _ if self.peek() == Some('-') && self.chars.get(self.at + 1).is_some_and(|end| *end != ']') => {
                    self.at += 1;
                    if self.next()? == '\\' {
                        self.next()?;
                    }
                    known = false;
                }
                c => chars.push(c),
            }
        }
        chars.sort_unstable();
        chars.dedup();
        Some(if known && !chars.is_empty() && chars.len() <= 8 { Lit::Exact(chars.iter().map(char::to_string).collect()) } else { Lit::Any })
    }
}

impl Needles {
    fn of(pattern: &str, flags: &str) -> Option<Self> {
        if flags.contains('u') || flags.contains('v') {
            return None;
        }
        let mut reader = Reader { chars: pattern.chars().collect(), at: 0 };
        let lit = reader.alternation()?;
        if reader.at != reader.chars.len() {
            return None;
        }
        let strings = required(lit)?;
        // Without `u` the engine sees a character past the BMP as two code units, which a needle of it does not follow.
        if strings.iter().any(|s| s.chars().any(|c| u32::from(c) > 0xFFFF)) {
            return None;
        }
        let fold = flags.contains('i');
        if fold && !strings.iter().all(|s| s.is_ascii()) {
            return None;
        }
        Some(Self { strings: if fold { strings.iter().map(|s| s.to_ascii_lowercase()).collect() } else { strings }, fold })
    }

    /// Whether `text`, a long one, holds none of the strings, so that the pattern has no match in it.
    fn absent_from(&self, text: &str) -> bool {
        text.len() >= NEEDLES_FROM && self.rule_out(text)
    }

    /// Whether `text` holds none of the strings (as [`Needles::fold`] reads it under `i`).
    fn rule_out(&self, text: &str) -> bool {
        if !self.fold {
            return !self.strings.iter().any(|s| text.contains(s.as_str()));
        }
        if text.is_ascii() {
            let lower = text.to_ascii_lowercase();
            return !self.strings.iter().any(|s| lower.contains(s.as_str()));
        }
        let read: Vec<u8> =
            text.chars().map(|c| if c.is_ascii() { c.to_ascii_lowercase() as u8 } else { ANY_CHARACTER }).collect();
        !self.strings.iter().any(|s| {
            read.windows(s.len()).any(|at| at.iter().zip(s.as_bytes()).all(|(&t, &n)| t == n || t == ANY_CHARACTER))
        })
    }
}

/// Test hooks (feature `prefilter-probe`): every pattern a [`JsRegex`] was built from, the decision without
/// [`Needles`], and a mode that applies them to every text or to none.
#[cfg(feature = "prefilter-probe")]
pub mod prefilter_probe {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicU8;
    use std::sync::atomic::Ordering;

    static BUILT: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    static RECORDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    static MODE: AtomicU8 = AtomicU8::new(Mode::Long as u8);

    /// Starts keeping every pattern built from now on ([`built`]).
    pub fn record() {
        RECORDING.store(true, Ordering::SeqCst);
    }

    pub(super) fn note(pattern: &str, flags: &str) {
        if RECORDING.load(Ordering::SeqCst) {
            BUILT.lock().unwrap().push((pattern.to_owned(), flags.to_owned()));
        }
    }

    /// When a pattern's strings are consulted.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum Mode {
        /// For texts of at least 64 KiB, as the product does.
        Long = 0,
        /// For every text.
        Always = 1,
        /// Never.
        Never = 2,
    }

    pub fn set_mode(mode: Mode) {
        MODE.store(mode as u8, Ordering::SeqCst);
    }

    pub(super) fn mode() -> Mode {
        match MODE.load(Ordering::SeqCst) {
            1 => Mode::Always,
            2 => Mode::Never,
            _ => Mode::Long,
        }
    }

    /// Every `(pattern, flags)` a `JsRegex` was built from since [`record`], each once, in the order first built.
    pub fn built() -> Vec<(String, String)> {
        let mut seen = std::collections::HashSet::new();
        BUILT.lock().unwrap().iter().filter(|built| seen.insert((*built).clone())).cloned().collect()
    }
}

/// Whether the character at `at` is the target of a preceding backslash.
fn escaped_before(chars: &[char], at: usize) -> bool {
    chars[..at].iter().rev().take_while(|c| **c == '\\').count() % 2 == 1
}

/// Under the `v` flag the engine differs from V8 in two class forms, both written equivalently:
/// * it refuses two reserved double punctuators in a row that are not the same (`[&^]`) and
///   reads `&-` as a bad character, where V8 refuses only a doubled one; every such character
///   in a class is escaped (`[\&\^]`), except the `&&` operator;
/// * it refuses `\b` (backspace) as the end of a range (`[\b-a]`); it is written `\x08`.
fn v_class_forms(pattern: &str) -> std::borrow::Cow<'_, str> {
    const DOUBLE: &str = "&!#$%*+,.:;<=>?@^`~";
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut depth = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() => {
                if depth > 0 && chars[i + 1] == 'b' {
                    out.push_str("\\x08");
                } else {
                    out.push('\\');
                    out.push(chars[i + 1]);
                }
                i += 2;
                continue;
            }
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            // The `&&` operator is the one doubled form V8 accepts; any other of these characters
            // is a plain character, and the escape keeps the engine from misreading it.
            // The `^` that negates a class is not a character.
            '^' if i > 0 && chars[i - 1] == '[' && !escaped_before(&chars, i - 1) => {}
            c if depth > 0 && DOUBLE.contains(c) => {
                if chars.get(i + 1) == Some(&c) {
                    out.push(c);
                    out.push(c);
                    i += 2;
                    continue;
                }
                out.push('\\');
            }
            _ => {}
        }
        out.push(c);
        i += 1;
    }
    if out == pattern { std::borrow::Cow::Borrowed(pattern) } else { std::borrow::Cow::Owned(out) }
}

/// Annex B: without the `u` flag, `\x` not followed by two hex digits is the letter `x`. The
/// engine rejects it inside a class, so it is written as the letter.
fn identity_hex_escapes(pattern: &str) -> std::borrow::Cow<'_, str> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut changed = false;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let hex = |k: usize| chars.get(k).is_some_and(char::is_ascii_hexdigit);
            if chars[i + 1] == 'x' && !(hex(i + 2) && hex(i + 3)) {
                out.push('x');
                changed = true;
            } else {
                out.push('\\');
                out.push(chars[i + 1]);
            }
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    if changed { std::borrow::Cow::Owned(out) } else { std::borrow::Cow::Borrowed(pattern) }
}

/// One match with its groups.
pub struct Caps<'t> {
    text: &'t str,
    found: regress::Match,
}

impl<'t> Caps<'t> {
    pub fn get(&self, group: usize) -> Option<&'t str> {
        self.found.group(group).map(|r| &self.text[r])
    }

    pub fn range(&self) -> Range<usize> {
        self.found.range()
    }
}

impl JsRegex {
    /// `new RegExp(pattern, flags)`. The error is the text of the `SyntaxError` V8 throws (see
    /// [`js_regex_error`]); a pattern V8 accepts but the engine cannot run says so.
    pub fn new(pattern: &str, flags: &str) -> Result<Self, String> {
        if let Some(message) = js_regex_error(pattern, flags) {
            return Err(message);
        }
        let source = if flags.contains('v') {
            v_class_forms(pattern)
        } else if flags.contains('u') {
            std::borrow::Cow::Borrowed(pattern)
        } else {
            identity_hex_escapes(pattern)
        };
        #[cfg(feature = "prefilter-probe")]
        prefilter_probe::note(pattern, flags);
        regress::Regex::with_flags(&source, flags).map(|regex| Self(regex, Needles::of(pattern, flags))).map_err(|error| {
            format!("Invalid regular expression: /{pattern}/{flags}: unsupported by the regex engine ({error})")
        })
    }

    /// A pattern fixed in the source; panics on a bad one.
    pub fn new_static(pattern: &str, flags: &str) -> Self {
        Self::new(pattern, flags).expect("static pattern")
    }

    /// Whether the pattern's [`Needles`] show that `text` has no match.
    fn hopeless(&self, text: &str) -> bool {
        #[cfg(feature = "prefilter-probe")]
        match prefilter_probe::mode() {
            prefilter_probe::Mode::Always => return self.1.as_ref().is_some_and(|needles| needles.rule_out(text)),
            prefilter_probe::Mode::Never => return false,
            prefilter_probe::Mode::Long => {}
        }
        self.1.as_ref().is_some_and(|needles| needles.absent_from(text))
    }

    /// The strings every match holds, and whether they are read under `i` (feature `prefilter-probe`).
    #[cfg(feature = "prefilter-probe")]
    pub fn needles(&self) -> Option<(&[String], bool)> {
        self.1.as_ref().map(|needles| (needles.strings.as_slice(), needles.fold))
    }

    /// Whether the strings rule out a match in `text` of any length (feature `prefilter-probe`).
    #[cfg(feature = "prefilter-probe")]
    pub fn needles_rule_out(&self, text: &str) -> bool {
        self.1.as_ref().is_some_and(|needles| needles.rule_out(text))
    }

    /// The engine's first match in `text`, without the strings (feature `prefilter-probe`).
    #[cfg(feature = "prefilter-probe")]
    pub fn engine_find(&self, text: &str) -> Option<Range<usize>> {
        self.0.find(text).map(|m| m.range())
    }

    fn first(&self, text: &str) -> Option<regress::Match> {
        if self.hopeless(text) { None } else { self.0.find(text) }
    }

    fn all<'a>(&'a self, text: &'a str) -> impl Iterator<Item = regress::Match> + 'a {
        (!self.hopeless(text)).then(|| self.0.find_iter(text)).into_iter().flatten()
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.first(text).is_some()
    }

    pub fn find(&self, text: &str) -> Option<Range<usize>> {
        self.first(text).map(|m| m.range())
    }

    pub fn find_iter<'a>(&'a self, text: &'a str) -> impl Iterator<Item = Range<usize>> + 'a {
        self.all(text).map(|m| m.range())
    }

    pub fn captures<'t>(&self, text: &'t str) -> Option<Caps<'t>> {
        self.first(text).map(|found| Caps { text, found })
    }

    pub fn captures_iter<'a>(&'a self, text: &'a str) -> impl Iterator<Item = Caps<'a>> + 'a {
        self.all(text).map(move |found| Caps { text, found })
    }

    /// `String.prototype.replace` with a global pattern and a replacer function.
    pub fn replace_all_with(&self, text: &str, with: impl Fn(&Caps) -> String) -> String {
        let mut out = String::new();
        let mut last = 0;
        for caps in self.captures_iter(text) {
            let whole = caps.range();
            out.push_str(&text[last..whole.start]);
            out.push_str(&with(&caps));
            last = whole.end;
        }
        out.push_str(&text[last..]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_boundaries_and_case_follow_javascript() {
        let re = JsRegex::new_static(r"\|\s*sh\b", "i");
        assert!(re.is_match("a |\u{a0}SH"));
        assert!(re.is_match("|\u{feff}sh"));
        assert!(!re.is_match("|\u{85}sh"));
        assert!(!re.is_match("| shx"));
        let all = JsRegex::new_static("a", "").replace_all_with("banana", |_| "o".into());
        assert_eq!(all, "bonono");
    }

    fn needles(pattern: &str, flags: &str) -> Option<Vec<String>> {
        Needles::of(pattern, flags).map(|n| n.strings)
    }

    #[test]
    fn needles_are_the_strings_every_match_holds() {
        let strings = |list: &[&str]| Some(list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        assert_eq!(needles(r"\bgit\b", "i"), strings(&["git"]));
        assert_eq!(needles(r"(?:^|\s)(?:Powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+-c", "i"), strings(&["powershell", "pwsh"]));
        assert_eq!(needles(r"\d?>&\d", "g"), strings(&[">&"]));
        assert_eq!(needles(r#"(?:^|[\s'"])[-/]e(?:c|n[a-z]*)?\s+['"]?([A-Za-z0-9+/]{4,}={0,2})"#, "gi"), strings(&["-e", "/e"]));
        assert_eq!(needles(r#"(^|[\s"'=,(])/([A-Za-z])/([^\s"'`|&;<>()]*)"#, "g"), strings(&["/"]));
        assert_eq!(needles(r"(?<name>ab)+c{2}", ""), strings(&["ab"]));
        assert_eq!(needles(r"x(?=yz)w", ""), strings(&["xw"]));
        // Nothing every match holds, or syntax not followed: the engine alone.
        // Code escapes and back references span characters the reader does not count (`\x41` is `A`, not `41`).
        for (pattern, flags) in [
            (r"a*", ""),
            (r"a|", ""),
            (r"\s+", "g"),
            (r"[^a]", ""),
            (r"a{0,3}", ""),
            (r"ab", "u"),
            (r"é", "i"),
            (r"(?", ""),
            (r"\x41bc", ""),
            (r"\u0041bc", ""),
            (r"\cAbc", ""),
            (r"(a)\12", ""),
            (r"(?<n>a)\k<n>bc", ""),
        ] {
            assert_eq!(needles(pattern, flags), None, "/{pattern}/{flags}");
        }
    }

    /// A long text the needles rule out has no match, and one that holds them is searched by the engine: either way the
    /// answer is the engine's own.
    #[test]
    fn the_needles_answer_what_the_engine_answers() {
        let filler = "a".repeat(NEEDLES_FROM);
        let texts = [
            filler.clone(),
            format!("{filler} git x"),
            format!("{filler} GIT x"),
            format!("{filler} 2>&1"),
            format!("{filler} digit"),
            format!("{filler} pwsh -c x"),
            format!("{filler} -E QUJDRA=="),
            // Non-ASCII characters an ASCII one may fold with: dotless i, long s, the Kelvin sign.
            format!("{filler} gıt x"),
            format!("{filler} pwſh -c x"),
            format!("{filler} \u{212a}git x"),
        ];
        for (pattern, flags) in [
            (r"\bgit\b", "i"),
            (r"\d?>&\d", "g"),
            (r"(?:^|\s)(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+-c", "i"),
            (r#"(?:^|[\s'"])[-/]e(?:c|n[a-z]*)?\s+['"]?([A-Za-z0-9+/]{4,}={0,2})"#, "gi"),
        ] {
            let ours = JsRegex::new_static(pattern, flags);
            let engine = regress::Regex::with_flags(pattern, flags).unwrap();
            assert!(ours.1.is_some(), "/{pattern}/{flags} has needles");
            for text in &texts {
                let want: Vec<_> = engine.find_iter(text).map(|m| m.range()).collect();
                assert_eq!(ours.find_iter(text).collect::<Vec<_>>(), want, "/{pattern}/{flags} on …{}", &text[filler.len()..]);
                assert_eq!(ours.find(text), want.first().cloned(), "/{pattern}/{flags} on …{}", &text[filler.len()..]);
            }
        }
    }

    #[test]
    fn a_bad_pattern_reports_v8s_message() {
        assert_eq!(
            JsRegex::new("(", "").err().as_deref(),
            Some("Invalid regular expression: /(/: Unterminated group")
        );
    }
}

#[cfg(test)]
mod sweep {
    /// Patterns V8 accepts that the engine rejects, from the Node sweep (`MIXDOG_JS_REGEX_CORPUS`).
    #[test]
    #[allow(clippy::disallowed_methods, reason = "developer-run sweep reads a scratch file; no lane in a unit test")]
    fn engine_gaps_on_the_full_sweep() {
        let Ok(path) = std::env::var("MIXDOG_JS_REGEX_CORPUS") else {
            return;
        };
        let text = std::fs::read_to_string(path).expect("corpus");
        let mut gaps = std::collections::BTreeMap::<String, Vec<String>>::new();
        for line in text.lines() {
            let (pattern, flags, expected): (String, String, Option<String>) = serde_json::from_str(line).expect("row");
            if expected.is_some() {
                continue;
            }
            if let Err(message) = super::JsRegex::new(&pattern, &flags) {
                let reason = message.rsplit("engine (").next().unwrap_or("").to_owned();
                let bucket = gaps.entry(reason).or_default();
                if bucket.len() < 8 {
                    bucket.push(format!("/{pattern}/{flags}"));
                }
            }
        }
        let shown: Vec<String> = gaps.iter().map(|(reason, rows)| format!("{reason}: {rows:?}")).collect();
        assert!(shown.is_empty(), "{}", shown.join("\n"));
    }
}
