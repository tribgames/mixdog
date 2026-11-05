//! The early errors of an ECMAScript pattern in unicode mode, with V8's exact `SyntaxError`
//! message for each, in the order V8's parser meets them. Kept next to `mixdog-js`'s
//! `js_regex_error` only while that one differs from Node: `tests/regex_errors.rs` holds
//! both to 186 curated and ~6000 fuzzed patterns recorded from Node, and this module is the
//! one that matches all of them. Delete it when `mixdog_js::js_regex_error` passes that test.

use std::collections::HashSet;

struct Parser {
    chars: Vec<char>,
    pos: usize,
    groups_total: usize,
    names: HashSet<String>,
    named_refs: Vec<String>,
}

type Check = Result<(), &'static str>;

#[derive(PartialEq, Eq)]
enum Atom {
    Char(u32),
    Set,
}

const BAD_PROPERTY: &str = "Invalid property name";
const BAD_CLASS_PROPERTY: &str = "Invalid property name in character class";

/// The V8 message for the first early error in `source`, if any.
pub fn early_error(source: &str, property_ok: &dyn Fn(&str) -> bool) -> Option<&'static str> {
    let chars: Vec<char> = source.chars().collect();
    let mut parser = Parser { groups_total: count_groups(&chars), chars, pos: 0, names: HashSet::new(), named_refs: Vec::new() };
    parser
        .disjunction(0, property_ok)
        .and_then(|()| if parser.named_refs.iter().all(|n| parser.names.contains(n)) { Ok(()) } else { Err("Invalid named capture referenced") })
        .err()
}

/// Capture groups of the whole pattern, counted up front (V8 scans for them first).
fn count_groups(chars: &[char]) -> usize {
    let (mut count, mut i, mut in_class) = (0, 0, false);
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            '[' => in_class = true,
            ']' => in_class = false,
            '(' if !in_class => {
                let capturing = chars.get(i + 1) != Some(&'?') || (chars.get(i + 2) == Some(&'<') && !matches!(chars.get(i + 3), Some('=' | '!')));
                count += usize::from(capturing);
            }
            _ => {}
        }
        i += 1;
    }
    count
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn disjunction(&mut self, depth: usize, property_ok: &dyn Fn(&str) -> bool) -> Check {
        loop {
            self.alternative(depth, property_ok)?;
            match self.peek() {
                Some('|') => self.pos += 1,
                Some(')') if depth == 0 => return Err("Unmatched ')'"),
                _ => return Ok(()),
            }
        }
    }

    fn alternative(&mut self, depth: usize, property_ok: &dyn Fn(&str) -> bool) -> Check {
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                if c == ')' && depth == 0 {
                    return Err("Unmatched ')'");
                }
                return Ok(());
            }
            self.term(property_ok)?;
        }
        Ok(())
    }

    /// `{n}`, `{n,}` or `{n,m}` at the cursor: its length and bounds, or `None` if it is not one.
    fn braced(&self) -> Option<(usize, u64, u64)> {
        let digits = |from: usize| -> usize { (from..).take_while(|k| self.at(*k).is_some_and(|c| c.is_ascii_digit())).count() };
        let num = |from: usize, len: usize| -> u64 {
            (from..from + len).fold(0u64, |acc, k| {
                acc.saturating_mul(10).saturating_add(u64::from(self.at(k).and_then(|c| c.to_digit(10)).unwrap_or(0))).min(u64::from(u32::MAX))
            })
        };
        let mut i = 1;
        let first = digits(i);
        if first == 0 {
            return None;
        }
        let min = num(i, first);
        i += first;
        let mut max = min;
        if self.at(i) == Some(',') {
            i += 1;
            let second = digits(i);
            max = if second == 0 { u64::MAX } else { num(i, second) };
            i += second;
        }
        (self.at(i) == Some('}')).then_some((i + 1, min, max))
    }

    fn term(&mut self, property_ok: &dyn Fn(&str) -> bool) -> Check {
        let c = self.peek().expect("term at a character");
        let mut quantifiable = true;
        match c {
            '^' | '$' => {
                self.pos += 1;
                quantifiable = false;
            }
            '*' | '+' | '?' => return Err("Nothing to repeat"),
            '{' => return Err(if self.braced().is_some() { "Nothing to repeat" } else { "Lone quantifier brackets" }),
            '}' | ']' => return Err("Lone quantifier brackets"),
            '(' => {
                if self.group(property_ok)? {
                    return self.quantifier(false, "Invalid quantifier");
                }
            }
            '[' => self.class(property_ok)?,
            '.' => self.pos += 1,
            '\\' => {
                if matches!(self.at(1), Some('b' | 'B')) {
                    self.pos += 2;
                    quantifiable = false;
                } else {
                    self.pos += 1;
                    self.escape(false, property_ok)?;
                }
            }
            _ => self.pos += 1,
        }
        self.quantifier(quantifiable, "Nothing to repeat")
    }

    /// A quantifier after an atom; `refusal` is V8's message when the atom takes none.
    fn quantifier(&mut self, quantifiable: bool, refusal: &'static str) -> Check {
        let Some(c) = self.peek() else { return Ok(()) };
        match c {
            '*' | '+' | '?' => {
                if !quantifiable {
                    return Err(refusal);
                }
                self.pos += 1;
            }
            '{' => match self.braced() {
                Some((len, min, max)) => {
                    if !quantifiable {
                        return Err(refusal);
                    }
                    if min > max {
                        return Err("numbers out of order in {} quantifier");
                    }
                    self.pos += len;
                }
                None => return Err(if quantifiable { "Incomplete quantifier" } else { "Lone quantifier brackets" }),
            },
            _ => return Ok(()),
        }
        if self.peek() == Some('?') {
            self.pos += 1;
        }
        Ok(())
    }

    /// Parses a group; `Ok(true)` for a lookaround (which takes no quantifier).
    fn group(&mut self, property_ok: &dyn Fn(&str) -> bool) -> Result<bool, &'static str> {
        self.pos += 1;
        let mut lookaround = false;
        let mut group_name = None;
        if self.peek() == Some('?') {
            match (self.at(1), self.at(2)) {
                (Some(':'), _) => self.pos += 2,
                (Some('=' | '!'), _) => {
                    self.pos += 2;
                    lookaround = true;
                }
                (Some('<'), Some('=' | '!')) => {
                    self.pos += 3;
                    lookaround = true;
                }
                (Some('<'), _) => {
                    self.pos += 2;
                    group_name = Some(self.group_name()?);
                }
                _ => return Err("Invalid group"),
            }
        }
        self.disjunction(1, property_ok)?;
        if self.peek() != Some(')') {
            return Err("Unterminated group");
        }
        self.pos += 1;
        // A repeated name is met when its group closes.
        if let Some(name) = group_name {
            if !self.names.insert(name) {
                return Err("Duplicate capture group name");
            }
        }
        Ok(lookaround)
    }

    /// A group name up to and including `>`.
    fn group_name(&mut self) -> Result<String, &'static str> {
        let mut name = String::new();
        loop {
            let Some(c) = self.peek() else { return Err("Invalid capture group name") };
            self.pos += 1;
            if c == '>' {
                break;
            }
            let ok = if name.is_empty() {
                c == '$' || c == '_' || c.is_alphabetic()
            } else {
                c == '$' || c == '_' || c.is_alphanumeric() || c == '\u{200c}' || c == '\u{200d}'
            };
            if !ok {
                return Err("Invalid capture group name");
            }
            name.push(c);
        }
        if name.is_empty() { Err("Invalid capture group name") } else { Ok(name) }
    }

    fn hex_run(&mut self, count: usize) -> Option<u32> {
        let digits: Vec<char> = (0..count).map_while(|k| self.at(k).filter(char::is_ascii_hexdigit)).collect();
        if digits.len() != count {
            return None;
        }
        self.pos += count;
        u32::from_str_radix(&digits.into_iter().collect::<String>(), 16).ok()
    }

    /// After `\u`: `XXXX` (with a following `\uXXXX` low surrogate joining a high one) or `{X…}`.
    fn unicode_escape(&mut self) -> Result<u32, &'static str> {
        const BAD: &str = "Invalid Unicode escape";
        if self.peek() == Some('{') {
            self.pos += 1;
            let start = self.pos;
            while self.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                self.pos += 1;
            }
            if start == self.pos || self.peek() != Some('}') {
                return Err(BAD);
            }
            let text: String = self.chars[start..self.pos].iter().collect();
            self.pos += 1;
            return match u32::from_str_radix(text.trim_start_matches('0'), 16) {
                Ok(v) if v <= 0x10_FFFF => Ok(v),
                Err(_) if text.chars().all(|c| c == '0') => Ok(0),
                _ => Err(BAD),
            };
        }
        let high = self.hex_run(4).ok_or(BAD)?;
        if (0xD800..0xDC00).contains(&high) && self.peek() == Some('\\') && self.at(1) == Some('u') {
            let save = self.pos;
            self.pos += 2;
            match self.hex_run(4) {
                Some(low) if (0xDC00..0xE000).contains(&low) => return Ok(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)),
                _ => self.pos = save,
            }
        }
        Ok(high)
    }

    /// After a backslash. Returns the atom it denotes (for class ranges).
    fn escape(&mut self, in_class: bool, property_ok: &dyn Fn(&str) -> bool) -> Result<Atom, &'static str> {
        let Some(c) = self.peek() else { return Err("\\ at end of pattern") };
        self.pos += 1;
        let property_error = if in_class { BAD_CLASS_PROPERTY } else { BAD_PROPERTY };
        Ok(match c {
            'd' | 'D' | 's' | 'S' | 'w' | 'W' => Atom::Set,
            'f' => Atom::Char(0x0C),
            'n' => Atom::Char(0x0A),
            'r' => Atom::Char(0x0D),
            't' => Atom::Char(0x09),
            'v' => Atom::Char(0x0B),
            'b' if in_class => Atom::Char(0x08),
            '-' if in_class => Atom::Char(u32::from('-')),
            '0' => {
                if self.peek().is_some_and(|d| d.is_ascii_digit()) {
                    return Err(if in_class { "Invalid class escape" } else { "Invalid decimal escape" });
                }
                Atom::Char(0)
            }
            '1'..='9' => {
                let mut n = c.to_digit(10).unwrap_or(0) as usize;
                while let Some(d) = self.peek().and_then(|d| d.to_digit(10)) {
                    n = n.saturating_mul(10).saturating_add(d as usize);
                    self.pos += 1;
                }
                if in_class {
                    return Err("Invalid class escape");
                }
                if n > self.groups_total {
                    return Err("Invalid escape");
                }
                Atom::Set
            }
            'c' => match self.peek() {
                Some(l) if l.is_ascii_alphabetic() => {
                    self.pos += 1;
                    Atom::Char(u32::from(l) % 32)
                }
                _ => return Err("Invalid Unicode escape"),
            },
            'x' => Atom::Char(self.hex_run(2).ok_or("Invalid escape")?),
            'u' => Atom::Char(self.unicode_escape()?),
            'p' | 'P' => {
                if self.peek() != Some('{') {
                    return Err(property_error);
                }
                let end = (self.pos..self.chars.len()).find(|i| self.chars[*i] == '}').ok_or(property_error)?;
                let name: String = self.chars[self.pos + 1..end].iter().collect();
                if !property_ok(&name) {
                    return Err(property_error);
                }
                self.pos = end + 1;
                Atom::Set
            }
            'k' => {
                if in_class {
                    return Err("Invalid escape");
                }
                if self.peek() != Some('<') {
                    return Err("Invalid named reference");
                }
                self.pos += 1;
                let name = self.group_name()?;
                self.named_refs.push(name);
                Atom::Set
            }
            '^' | '$' | '\\' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '/' => Atom::Char(u32::from(c)),
            _ => return Err("Invalid escape"),
        })
    }

    fn class_atom(&mut self, property_ok: &dyn Fn(&str) -> bool) -> Result<Atom, &'static str> {
        match self.peek() {
            None => Err("Unterminated character class"),
            Some('\\') => {
                self.pos += 1;
                self.escape(true, property_ok)
            }
            Some(c) => {
                self.pos += 1;
                Ok(Atom::Char(u32::from(c)))
            }
        }
    }

    fn class(&mut self, property_ok: &dyn Fn(&str) -> bool) -> Check {
        self.pos += 1;
        if self.peek() == Some('^') {
            self.pos += 1;
        }
        loop {
            match self.peek() {
                None => return Err("Unterminated character class"),
                Some(']') => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => {}
            }
            let first = self.class_atom(property_ok)?;
            if self.peek() == Some('-') && self.at(1) != Some(']') {
                self.pos += 1;
                let second = self.class_atom(property_ok)?;
                match (first, second) {
                    (Atom::Char(a), Atom::Char(b)) if a > b => return Err("Range out of order in character class"),
                    (Atom::Char(_), Atom::Char(_)) => {}
                    _ => return Err("Invalid character class"),
                }
            }
        }
    }
}
