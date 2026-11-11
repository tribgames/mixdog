//! The `SyntaxError` text V8 (Node 22, V8 12.4) throws for `new RegExp(pattern, flags)`.
//!
//! This is a port of the error-reporting paths of V8's `RegExpParserImpl` (`regexp-parser.cc`):
//! it walks the pattern the way V8 does, so the *first* error V8 meets is the one reported, with
//! V8's wording. It builds no tree. Property names (`\p{…}`) are checked against the regex
//! engine's tables, which are ECMAScript's.
//!
//! Not ported: the class-set syntax of the `v` flag (nested classes, `--`, `&&`, `\q{}`); a `v`
//! pattern is checked outside its classes only, and the tests leave `v` patterns with a class out.

use std::sync::LazyLock;

const END: u32 = u32::MAX;

/// V8's message for `pattern`/`flags`, or `None` when V8 accepts them.
pub fn js_regex_error(pattern: &str, flags: &str) -> Option<String> {
    if !valid_flags(flags) {
        return Some(format!("Invalid flags supplied to RegExp constructor '{flags}'"));
    }
    let unicode = flags.contains(['u', 'v']);
    let reason = Parser::new(pattern, unicode, flags.contains('v')).parse().err()?;
    // V8 prints the flags in its own order, whatever order they were written in.
    let shown: String = "dgimsuvy".chars().filter(|c| flags.contains(*c)).collect();
    Some(format!("Invalid regular expression: /{pattern}/{shown}: {reason}"))
}

/// `JSRegExp::FlagsFromString`: each of `dgimsuvy` at most once, and not `u` with `v`.
fn valid_flags(flags: &str) -> bool {
    let mut seen = String::new();
    for c in flags.chars() {
        if !"dgimsuvy".contains(c) || seen.contains(c) {
            return false;
        }
        seen.push(c);
    }
    !(seen.contains('u') && seen.contains('v'))
}

type Fail<T = ()> = Result<T, &'static str>;

const UNTERMINATED_GROUP: &str = "Unterminated group";
const UNMATCHED_PAREN: &str = "Unmatched ')'";
const ESCAPE_AT_END: &str = "\\ at end of pattern";
const INVALID_PROPERTY_NAME: &str = "Invalid property name";
const INVALID_CLASS_PROPERTY_NAME: &str = "Invalid property name in character class";
const INVALID_ESCAPE: &str = "Invalid escape";
const INVALID_DECIMAL_ESCAPE: &str = "Invalid decimal escape";
const INVALID_UNICODE_ESCAPE: &str = "Invalid Unicode escape";
const INVALID_CLASS_ESCAPE: &str = "Invalid class escape";
const NOTHING_TO_REPEAT: &str = "Nothing to repeat";
const LONE_QUANTIFIER_BRACKETS: &str = "Lone quantifier brackets";
const RANGE_OUT_OF_ORDER: &str = "numbers out of order in {} quantifier";
const INCOMPLETE_QUANTIFIER: &str = "Incomplete quantifier";
const INVALID_QUANTIFIER: &str = "Invalid quantifier";
const INVALID_GROUP: &str = "Invalid group";
const INVALID_CAPTURE_GROUP_NAME: &str = "Invalid capture group name";
const DUPLICATE_CAPTURE_GROUP_NAME: &str = "Duplicate capture group name";
const INVALID_NAMED_REFERENCE: &str = "Invalid named reference";
const INVALID_NAMED_CAPTURE_REFERENCE: &str = "Invalid named capture referenced";
const INVALID_CHARACTER_CLASS: &str = "Invalid character class";
const UNTERMINATED_CHARACTER_CLASS: &str = "Unterminated character class";
const OUT_OF_ORDER_CHARACTER_CLASS: &str = "Range out of order in character class";
const STACK_OVERFLOW: &str = "Maximum call stack size exceeded";
const MAX_CLASS_DEPTH: usize = 1000;
const INVALID_CHARACTER_IN_CLASS: &str = "Invalid character in character class";
const INVALID_CLASS_SET_OPERATION: &str = "Invalid set operation in character class";
const NEGATED_CLASS_WITH_STRINGS: &str = "Negated character class may contain strings";

/// `RegExpTree::kInfinity`.
const INFINITY: i64 = i32::MAX as i64;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Capture,
    Grouping,
    Lookahead,
    Lookbehind,
}

struct Open {
    group: Group,
    name: Option<Vec<u32>>,
}

/// An operand of a `v`-flag class.
#[derive(Clone, Copy)]
struct SetOperand {
    /// The code point of a single-character operand (the only kind a range can use).
    character: Option<u32>,
    /// Can match a string.
    strings: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InClass {
    No,
    Yes,
}

struct Parser {
    src: Vec<u16>,
    pos: usize,
    unicode: bool,
    /// The `v` flag.
    unicode_sets: bool,
    class_depth: usize,
    /// Capture-group names are always read as code points (`ForceUnicodeScope`).
    force_unicode: u32,
    captures_started: usize,
    has_named_captures: Option<bool>,
    capture_count: Option<usize>,
    named_captures: Vec<Vec<u32>>,
    named_back_references: Vec<Vec<u32>>,
}

fn hex_value(c: u32) -> Option<u32> {
    char::from_u32(c)?.to_digit(16).filter(|_| c < 128)
}

/// The character for `c`, `None` at the end of the pattern. A lone surrogate unit (non-Unicode
/// patterns read UTF-16 units) is an ordinary character that matches no special case.
fn as_char(c: u32) -> Option<char> {
    (c != END).then(|| char::from_u32(c).unwrap_or('\u{fffd}'))
}

fn is_digit(c: u32) -> bool {
    (u32::from(b'0')..=u32::from(b'9')).contains(&c)
}

fn is_syntax_character_or_slash(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "^$\\.*+?()[]{}|/".contains(c))
}

/// `ClassSetReservedPunctuator`: escapable inside a `v`-flag class.
fn is_class_set_reserved_punctuator(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "&-!#%,:;<=>@`~".contains(c))
}

/// `ClassSetSyntaxCharacter`.
fn is_class_set_syntax_character(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "()[]{}/-\\|".contains(c))
}

/// The characters that make a `ClassSetReservedDoublePunctuator` when doubled.
fn is_class_set_double_punctuator(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "&!#$%*+,.:;<=>?@^`~".contains(c))
}

fn is_lead(c: u32) -> bool {
    (0xD800..0xDC00).contains(&c)
}

fn is_trail(c: u32) -> bool {
    (0xDC00..0xE000).contains(&c)
}

fn property_regex_accepts(source: &str) -> bool {
    regress::Regex::with_flags(source, "u").is_ok()
}

fn is_identifier_start(c: u32) -> bool {
    static START: LazyLock<regress::Regex> =
        LazyLock::new(|| regress::Regex::with_flags(r"^[\p{ID_Start}$_]$", "u").expect("static pattern"));
    char::from_u32(c).is_some_and(|c| START.find(c.encode_utf8(&mut [0; 4])).is_some())
}

fn is_identifier_part(c: u32) -> bool {
    static PART: LazyLock<regress::Regex> = LazyLock::new(|| {
        regress::Regex::with_flags(r"^[\p{ID_Continue}$_\u200c\u200d]$", "u").expect("static pattern")
    });
    char::from_u32(c).is_some_and(|c| PART.find(c.encode_utf8(&mut [0; 4])).is_some())
}

impl Parser {
    fn new(pattern: &str, unicode: bool, unicode_sets: bool) -> Self {
        Self {
            src: pattern.encode_utf16().collect(),
            pos: 0,
            unicode,
            unicode_sets,
            class_depth: 0,
            force_unicode: 0,
            captures_started: 0,
            has_named_captures: None,
            capture_count: None,
            named_captures: Vec::new(),
            named_back_references: Vec::new(),
        }
    }

    fn is_unicode(&self) -> bool {
        self.unicode || self.force_unicode > 0
    }

    /// The character at `at` and its length in units; a surrogate pair is one character in
    /// Unicode mode.
    fn decode(&self, at: usize) -> (u32, usize) {
        let Some(&unit) = self.src.get(at) else {
            return (END, 0);
        };
        let unit = u32::from(unit);
        if self.is_unicode()
            && is_lead(unit)
            && let Some(&next) = self.src.get(at + 1)
            && is_trail(u32::from(next))
        {
            return (0x10000 + ((unit - 0xD800) << 10) + (u32::from(next) - 0xDC00), 2);
        }
        (unit, 1)
    }

    fn current(&self) -> u32 {
        self.decode(self.pos).0
    }

    fn next(&self) -> u32 {
        let (_, width) = self.decode(self.pos);
        self.decode(self.pos + width).0
    }

    fn has_next(&self) -> bool {
        let (_, width) = self.decode(self.pos);
        self.pos + width < self.src.len()
    }

    fn advance(&mut self) {
        let (_, width) = self.decode(self.pos);
        self.pos += width.max(usize::from(self.pos < self.src.len()));
    }

    fn advance_by(&mut self, count: usize) {
        for _ in 0..count {
            self.advance();
        }
    }

    fn rewind_by_one_codepoint(&mut self) {
        self.pos -= 1;
        if self.is_unicode() && self.pos > 0 && is_trail(u32::from(self.src[self.pos])) && is_lead(u32::from(self.src[self.pos - 1])) {
            self.pos -= 1;
        }
    }

    fn parse(mut self) -> Fail {
        let mut open: Vec<Open> = Vec::new();
        self.parse_disjunction(&mut open)?;
        if !self.named_back_references.is_empty() {
            for name in std::mem::take(&mut self.named_back_references) {
                if !self.named_captures.contains(&name) {
                    return Err(INVALID_NAMED_CAPTURE_REFERENCE);
                }
            }
        }
        Ok(())
    }

    fn parse_disjunction(&mut self, open: &mut Vec<Open>) -> Fail {
        loop {
            // Set by a closing lookaround: whether it was a lookbehind. Quantifying it is the
            // `AddQuantifierToAtom` failure.
            let mut closed_lookaround: Option<bool> = None;
            let c = self.current();
            match c {
                END => {
                    return if open.is_empty() { Ok(()) } else { Err(UNTERMINATED_GROUP) };
                }
                0x29 /* ) */ => {
                    let Some(group) = open.pop() else {
                        return Err(UNMATCHED_PAREN);
                    };
                    if group.group == Group::Capture
                        && let Some(name) = group.name
                    {
                        if self.named_captures.contains(&name) {
                            return Err(DUPLICATE_CAPTURE_GROUP_NAME);
                        }
                        self.named_captures.push(name);
                    }
                    self.advance();
                    if matches!(group.group, Group::Lookahead | Group::Lookbehind) {
                        closed_lookaround = Some(group.group == Group::Lookbehind);
                    }
                }
                0x7C /* | */ => {
                    self.advance();
                    continue;
                }
                0x2A | 0x2B | 0x3F /* * + ? */ => return Err(NOTHING_TO_REPEAT),
                0x5E | 0x24 /* ^ $ */ => {
                    self.advance();
                    continue;
                }
                0x28 /* ( */ => {
                    self.open_parenthesis(open)?;
                    continue;
                }
                0x5B /* [ */ => {
                    self.character_class()?;
                }
                0x2E /* . */ => self.advance(),
                0x5C /* \ */ => {
                    if self.atom_escape()? {
                        continue;
                    }
                }
                0x7B /* { */ => {
                    if self.interval_quantifier()?.is_some() {
                        return Err(NOTHING_TO_REPEAT);
                    }
                    if self.is_unicode() {
                        return Err(LONE_QUANTIFIER_BRACKETS);
                    }
                    self.advance();
                }
                0x7D | 0x5D /* } ] */ => {
                    if self.is_unicode() {
                        return Err(LONE_QUANTIFIER_BRACKETS);
                    }
                    self.advance();
                }
                _ => self.advance(),
            }
            // Quantifier.
            match self.current() {
                0x2A | 0x2B | 0x3F => self.advance(),
                0x7B => match self.interval_quantifier()? {
                    Some((min, max)) => {
                        if max < min {
                            return Err(RANGE_OUT_OF_ORDER);
                        }
                    }
                    None if self.is_unicode() => return Err(INCOMPLETE_QUANTIFIER),
                    None => continue,
                },
                _ => continue,
            }
            if self.current() == 0x3F {
                self.advance();
            }
            if let Some(lookbehind) = closed_lookaround
                && (self.is_unicode() || lookbehind)
            {
                return Err(INVALID_QUANTIFIER);
            }
        }
    }

    /// `ParseOpenParenthesis`.
    fn open_parenthesis(&mut self, open: &mut Vec<Open>) -> Fail {
        let mut group = Group::Capture;
        let mut named = false;
        self.advance();
        if self.current() == 0x3F {
            match self.next() {
                0x3A /* : */ => {
                    self.advance_by(2);
                    group = Group::Grouping;
                }
                0x3D | 0x21 /* = ! */ => {
                    self.advance_by(2);
                    group = Group::Lookahead;
                }
                0x3C /* < */ => {
                    self.advance();
                    match self.next() {
                        0x3D | 0x21 => {
                            self.advance_by(2);
                            group = Group::Lookbehind;
                        }
                        _ => {
                            named = true;
                            self.has_named_captures = Some(true);
                            self.advance();
                        }
                    }
                }
                _ => return Err(INVALID_GROUP),
            }
        }
        let mut name = None;
        if group == Group::Capture {
            self.captures_started += 1;
            if named {
                name = Some(self.capture_group_name()?);
            }
        }
        open.push(Open { group, name });
        Ok(())
    }

    /// `ParseCaptureGroupName`: `current()` is the first name character.
    fn capture_group_name(&mut self) -> Fail<Vec<u32>> {
        self.force_unicode += 1;
        let result = self.capture_group_name_inner();
        self.force_unicode -= 1;
        result
    }

    fn capture_group_name_inner(&mut self) -> Fail<Vec<u32>> {
        // V8 rewinds the advance that moved onto the first character, then advances in the loop.
        self.rewind_by_one_codepoint();
        let mut name = Vec::new();
        let mut at_start = true;
        loop {
            self.advance();
            let mut c = self.current();
            if c == 0x5C && self.next() == u32::from(b'u') {
                self.advance_by(2);
                match self.unicode_escape() {
                    Some(value) => c = value,
                    None => return Err(INVALID_UNICODE_ESCAPE),
                }
                self.rewind_by_one_codepoint();
            }
            if c == 0x5C {
                return Err(INVALID_CAPTURE_GROUP_NAME);
            }
            if at_start {
                if !is_identifier_start(c) {
                    return Err(INVALID_CAPTURE_GROUP_NAME);
                }
                name.push(c);
                at_start = false;
            } else if c == 0x3E {
                break;
            } else if is_identifier_part(c) {
                name.push(c);
            } else {
                return Err(INVALID_CAPTURE_GROUP_NAME);
            }
        }
        // The final advance moves past the `>`.
        self.advance();
        Ok(name)
    }

    /// `ParseHexEscape`.
    fn hex_escape(&mut self, length: usize) -> Option<u32> {
        let start = self.pos;
        let mut value = 0;
        for _ in 0..length {
            let Some(digit) = hex_value(self.current()) else {
                self.pos = start;
                return None;
            };
            value = value * 16 + digit;
            self.advance();
        }
        Some(value)
    }

    /// `ParseUnicodeEscape`; `\u` is already read.
    fn unicode_escape(&mut self) -> Option<u32> {
        if self.current() == 0x7B && self.is_unicode() {
            let start = self.pos;
            self.advance();
            if let Some(value) = self.unlimited_hex(0x10FFFF)
                && self.current() == 0x7D
            {
                self.advance();
                return Some(value);
            }
            self.pos = start;
            return None;
        }
        let value = self.hex_escape(4)?;
        if self.is_unicode() && is_lead(value) && self.current() == 0x5C {
            let start = self.pos;
            if self.next() == u32::from(b'u') {
                self.advance_by(2);
                if let Some(trail) = self.hex_escape(4)
                    && is_trail(trail)
                {
                    return Some(0x10000 + ((value - 0xD800) << 10) + (trail - 0xDC00));
                }
            }
            self.pos = start;
        }
        Some(value)
    }

    fn unlimited_hex(&mut self, max: u32) -> Option<u32> {
        let mut value = 0u32;
        let mut digit = hex_value(self.current())?;
        loop {
            value = value * 16 + digit;
            if value > max {
                return None;
            }
            self.advance();
            match hex_value(self.current()) {
                Some(next) => digit = next,
                None => return Some(value),
            }
        }
    }

    /// `ParseIntervalQuantifier`: `Some((min, max))` and the position after `}`, or `None` and
    /// the position unchanged.
    fn interval_quantifier(&mut self) -> Fail<Option<(i64, i64)>> {
        let start = self.pos;
        self.advance();
        if !is_digit(self.current()) {
            self.pos = start;
            return Ok(None);
        }
        let number = |p: &mut Self| -> i64 {
            let mut value: i64 = 0;
            while is_digit(p.current()) {
                let next = i64::from(p.current() - u32::from(b'0'));
                if value > (INFINITY - next) / 10 {
                    while is_digit(p.current()) {
                        p.advance();
                    }
                    return INFINITY;
                }
                value = 10 * value + next;
                p.advance();
            }
            value
        };
        let min = number(self);
        let max;
        if self.current() == 0x7D {
            max = min;
            self.advance();
        } else if self.current() == 0x2C {
            self.advance();
            if self.current() == 0x7D {
                max = INFINITY;
                self.advance();
            } else {
                max = number(self);
                if self.current() != 0x7D {
                    self.pos = start;
                    return Ok(None);
                }
                self.advance();
            }
        } else {
            self.pos = start;
            return Ok(None);
        }
        Ok(Some((min, max)))
    }

    /// `ScanForCaptures`: counts the capture groups of the whole pattern and notes named ones.
    fn scan_for_captures(&mut self, in_class: InClass) {
        let saved = self.pos;
        let mut count = self.captures_started;
        if in_class == InClass::Yes {
            loop {
                let c = self.current();
                if c == END {
                    break;
                }
                self.advance();
                if c == 0x5C {
                    self.advance();
                } else if c == 0x5D {
                    break;
                }
            }
        }
        loop {
            let n = self.current();
            if n == END {
                break;
            }
            self.advance();
            match n {
                0x5C => self.advance(),
                0x5B => loop {
                    let c = self.current();
                    if c == END {
                        break;
                    }
                    self.advance();
                    if c == 0x5C {
                        self.advance();
                    } else if c == 0x5D {
                        break;
                    }
                },
                0x28 => {
                    if self.current() == 0x3F {
                        self.advance();
                        if self.current() != 0x3C {
                            continue;
                        }
                        self.advance();
                        if self.current() == 0x3D || self.current() == 0x21 {
                            continue;
                        }
                        self.has_named_captures = Some(true);
                    }
                    count += 1;
                }
                _ => {}
            }
        }
        self.capture_count = Some(count);
        if self.has_named_captures.is_none() {
            self.has_named_captures = Some(false);
        }
        self.pos = saved;
    }

    fn has_named_captures(&mut self, in_class: InClass) -> bool {
        if self.has_named_captures.is_none() {
            self.scan_for_captures(in_class);
        }
        self.has_named_captures.unwrap_or(false)
    }

    /// `ParseBackReferenceIndex`: `current()` is the backslash. On success the position is past
    /// the digits.
    fn back_reference_index(&mut self) -> bool {
        let start = self.pos;
        let first = self.next();
        if !(u32::from(b'1')..=u32::from(b'9')).contains(&first) {
            return false;
        }
        let mut value = i64::from(first - u32::from(b'0'));
        self.advance_by(2);
        while is_digit(self.current()) {
            value = (10 * value + i64::from(self.current() - u32::from(b'0'))).min(1 << 20);
            self.advance();
        }
        if value as usize > self.captures_started {
            if self.capture_count.is_none() {
                self.scan_for_captures(InClass::No);
            }
            if value as usize > self.capture_count.unwrap_or(0) {
                self.pos = start;
                return false;
            }
        }
        true
    }

    /// `ParseOctalLiteral`: consumes up to three octal digits.
    fn octal_literal(&mut self) {
        let is_octal = |c: u32| (u32::from(b'0')..=u32::from(b'7')).contains(&c);
        let mut value = self.current() - u32::from(b'0');
        self.advance();
        if is_octal(self.current()) {
            value = value * 8 + self.current() - u32::from(b'0');
            self.advance();
            if value < 32 && is_octal(self.current()) {
                self.advance();
            }
        }
    }

    /// `\p{…}` / `\P{…}` after the `p`: `ParsePropertyClassName` and the table lookup.
    fn property_class(&mut self, negated: bool) -> Option<bool> {
        if self.current() != 0x7B {
            return None;
        }
        let (mut first, mut second) = (String::new(), None::<String>);
        let is_value_char = |c: u32| char::from_u32(c).is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        self.advance();
        while self.current() != 0x7D && self.current() != 0x3D {
            if !is_value_char(self.current()) || !self.has_next() {
                return None;
            }
            first.push(char::from_u32(self.current()).expect("ascii"));
            self.advance();
        }
        if self.current() == 0x3D {
            let mut value = String::new();
            self.advance();
            while self.current() != 0x7D {
                if !is_value_char(self.current()) || !self.has_next() {
                    return None;
                }
                value.push(char::from_u32(self.current()).expect("ascii"));
                self.advance();
            }
            second = Some(value);
        }
        self.advance();
        // Properties of strings exist under the `v` flag only, and cannot be negated.
        const OF_STRINGS: [&str; 7] = [
            "Basic_Emoji",
            "Emoji_Keycap_Sequence",
            "RGI_Emoji_Modifier_Sequence",
            "RGI_Emoji_Flag_Sequence",
            "RGI_Emoji_Tag_Sequence",
            "RGI_Emoji_ZWJ_Sequence",
            "RGI_Emoji",
        ];
        if second.is_none() && OF_STRINGS.contains(&first.as_str()) {
            return (self.unicode_sets && !negated).then_some(true);
        }
        let source = match second {
            Some(value) => format!(r"\p{{{first}={value}}}"),
            None => format!(r"\p{{{first}}}"),
        };
        property_regex_accepts(&source).then_some(false)
    }

    /// An escape outside a class; `current()` is the backslash. `Ok(true)` when it was an
    /// assertion (`\b`, `\B`), which takes no quantifier.
    fn atom_escape(&mut self) -> Fail<bool> {
        let next = self.next();
        match as_char(next) {
            None => Err(ESCAPE_AT_END),
            Some('d' | 'D' | 's' | 'S' | 'w' | 'W') => {
                self.advance_by(2);
                Ok(false)
            }
            Some('p' | 'P') => {
                if self.is_unicode() {
                    self.advance_by(2);
                    let negated = next == u32::from(b'P');
                    if self.property_class(negated).is_none() {
                        return Err(INVALID_PROPERTY_NAME);
                    }
                } else {
                    self.advance_by(2);
                }
                Ok(false)
            }
            Some('k') => {
                if self.is_unicode() || self.has_named_captures(InClass::No) {
                    self.advance_by(2);
                    self.named_reference()?;
                    Ok(false)
                } else {
                    self.identity_or_digit_escape()
                }
            }
            Some('1'..='9') => self.identity_or_digit_escape(),
            Some('0') => {
                self.advance();
                if self.is_unicode() && is_digit(self.next()) {
                    return Err(INVALID_DECIMAL_ESCAPE);
                }
                self.octal_literal();
                Ok(false)
            }
            Some('b' | 'B') => {
                self.advance_by(2);
                Ok(true)
            }
            Some('f' | 'n' | 'r' | 't' | 'v') => {
                self.advance_by(2);
                Ok(false)
            }
            Some('c') => {
                self.advance();
                let control = self.next();
                let letter = control & !(u32::from(b'a') ^ u32::from(b'A'));
                if !(u32::from(b'A')..=u32::from(b'Z')).contains(&letter) {
                    if self.is_unicode() {
                        return Err(INVALID_UNICODE_ESCAPE);
                    }
                } else {
                    self.advance_by(2);
                    return Ok(false);
                }
                // The backslash stays a literal character.
                Ok(false)
            }
            Some('x') => {
                self.advance_by(2);
                // An invalid `\x` is the letter `x` unless the pattern is Unicode.
                if self.hex_escape(2).is_some() || !self.is_unicode() {
                    Ok(false)
                } else {
                    Err(INVALID_ESCAPE)
                }
            }
            Some('u') => {
                self.advance_by(2);
                if self.unicode_escape().is_some() || !self.is_unicode() {
                    Ok(false)
                } else {
                    Err(INVALID_UNICODE_ESCAPE)
                }
            }
            Some(_) => {
                self.advance();
                if !self.is_unicode() || is_syntax_character_or_slash(self.current()) {
                    self.advance();
                    Ok(false)
                } else {
                    Err(INVALID_ESCAPE)
                }
            }
        }
    }

    /// The `\k` (without named groups, non-Unicode) and `\1`–`\9` cases, which share V8's
    /// back-reference / legacy-octal fall-through.
    fn identity_or_digit_escape(&mut self) -> Fail<bool> {
        if self.next() != u32::from(b'k') {
            if self.back_reference_index() {
                return Ok(false);
            }
            if self.is_unicode() {
                return Err(INVALID_ESCAPE);
            }
            let first_digit = self.next();
            if first_digit == u32::from(b'8') || first_digit == u32::from(b'9') {
                self.advance_by(2);
                return Ok(false);
            }
            self.advance();
            self.octal_literal();
            return Ok(false);
        }
        // `\k` as an identity escape.
        self.advance();
        if self.is_unicode() && !is_syntax_character_or_slash(self.current()) {
            return Err(INVALID_ESCAPE);
        }
        self.advance();
        Ok(false)
    }

    /// `ParseNamedReference`: `current()` follows `\k`.
    fn named_reference(&mut self) -> Fail {
        if self.current() != 0x3C {
            return Err(INVALID_NAMED_REFERENCE);
        }
        self.advance();
        let name = self.capture_group_name()?;
        self.named_back_references.push(name);
        Ok(())
    }

    /// `ParseCharacterClass`; `current()` is `[`.
    /// Whether the class can match a string (only possible under the `v` flag).
    fn character_class(&mut self) -> Fail<bool> {
        // Classes nest under `v`; V8 stops at its stack limit, this at a fixed depth.
        if self.class_depth >= MAX_CLASS_DEPTH {
            return Err(STACK_OVERFLOW);
        }
        self.class_depth += 1;
        let result = self.character_class_inner();
        self.class_depth -= 1;
        result
    }

    fn character_class_inner(&mut self) -> Fail<bool> {
        self.advance();
        let mut negated = false;
        if self.current() == 0x5E {
            negated = true;
            self.advance();
        }
        if self.current() == 0x5D {
            self.advance();
            return Ok(false);
        }
        if self.unicode_sets {
            let strings = self.class_set()?;
            if negated && strings {
                return Err(NEGATED_CLASS_WITH_STRINGS);
            }
            return Ok(strings && !negated);
        }
        while self.current() != END && self.current() != 0x5D {
            let (first, first_is_class) = self.class_atom()?;
            if self.current() == 0x2D {
                self.advance();
                if self.current() == END {
                    break;
                }
                if self.current() == 0x5D {
                    break;
                }
                let (second, second_is_class) = self.class_atom()?;
                if first_is_class || second_is_class {
                    if self.is_unicode() {
                        return Err(INVALID_CHARACTER_CLASS);
                    }
                    continue;
                }
                if first > second {
                    return Err(OUT_OF_ORDER_CHARACTER_CLASS);
                }
            }
        }
        if self.current() == END {
            return Err(UNTERMINATED_CHARACTER_CLASS);
        }
        self.advance();
        Ok(false)
    }

    /// The body of a `v`-flag class (after `[`, `^` and the empty-class check): a union, an
    /// intersection (`&&`) or a subtraction (`--`) of operands. Returns whether the class can
    /// match a string. Consumes the closing `]`.
    fn class_set(&mut self) -> Fail<bool> {
        let first = self.set_operand()?;
        let double = |p: &Self, c: u32| p.current() == c && p.next() == c;
        let strings = if double(self, 0x2D) {
            // Subtraction: strings remain only if the first operand has them.
            self.set_operation(0x2D)?;
            first.strings
        } else if double(self, 0x26) {
            // Intersection: strings remain only if every operand has them.
            self.set_operation_all(first.strings)?
        } else {
            self.set_union(first)?
        };
        if self.current() == END {
            return Err(UNTERMINATED_CHARACTER_CLASS);
        }
        self.advance();
        Ok(strings)
    }

    /// `ParseClassSubtraction`: `--` operand repeated.
    fn set_operation(&mut self, operator: u32) -> Fail {
        while self.current() != END && self.current() != 0x5D {
            if self.current() != operator || self.next() != operator {
                return Err(INVALID_CLASS_SET_OPERATION);
            }
            self.advance_by(2);
            self.set_operand()?;
        }
        Ok(())
    }

    /// `ParseClassIntersection`: `&&` operand repeated; `[lookahead ≠ &]` after each `&&`.
    fn set_operation_all(&mut self, mut all_strings: bool) -> Fail<bool> {
        while self.current() != END && self.current() != 0x5D {
            if self.current() != 0x26 || self.next() != 0x26 {
                return Err(INVALID_CLASS_SET_OPERATION);
            }
            self.advance_by(2);
            if self.current() == 0x26 {
                return Err(INVALID_CHARACTER_IN_CLASS);
            }
            all_strings &= self.set_operand()?.strings;
        }
        Ok(all_strings)
    }

    /// `ParseClassUnion`: operands and `a-b` ranges.
    fn set_union(&mut self, first: SetOperand) -> Fail<bool> {
        let mut last = first;
        let mut strings = first.strings;
        while self.current() != END && self.current() != 0x5D {
            if self.current() == 0x2D {
                if self.next() == 0x2D {
                    return Err(INVALID_CLASS_SET_OPERATION);
                }
                self.advance();
                // A `-` after something that is not a single character cannot make a range.
                let Some(from) = last.character else {
                    return Err(if self.current() == END {
                        UNTERMINATED_CHARACTER_CLASS
                    } else {
                        INVALID_CHARACTER_CLASS
                    });
                };
                // A class escape or `\q{…}` cannot end a range; V8 refuses it on sight. A nested
                // class is parsed first (its own errors win).
                if self.current() == 0x5B {
                    self.character_class()?;
                    return Err(INVALID_CHARACTER_CLASS);
                }
                if self.current() == 0x5C {
                    let (_, width) = self.decode(self.pos);
                    let after_next = self.decode(self.pos + width + 1).0;
                    let escape = as_char(self.next());
                    // `\q` counts only as the start of `\q{`; otherwise it is a bad escape.
                    if escape.is_some_and(|c| "dDsSwWpP".contains(c)) || (escape == Some('q') && after_next == 0x7B) {
                        return Err(INVALID_CHARACTER_CLASS);
                    }
                }
                let to = self.set_character()?;
                if from > to {
                    return Err(OUT_OF_ORDER_CHARACTER_CLASS);
                }
                last = SetOperand { character: None, strings: false };
                continue;
            }
            if self.current() == 0x26 && self.next() == 0x26 {
                return Err(INVALID_CLASS_SET_OPERATION);
            }
            last = self.set_operand()?;
            strings |= last.strings;
        }
        Ok(strings)
    }

    /// `ParseClassSetOperand`: a nested class, `\q{…}`, a class escape, or one character.
    fn set_operand(&mut self) -> Fail<SetOperand> {
        let classes_only = SetOperand { character: None, strings: false };
        if self.current() == 0x5B {
            let strings = self.character_class()?;
            return Ok(SetOperand { character: None, strings });
        }
        if self.current() == 0x5C {
            match as_char(self.next()) {
                Some('d' | 'D' | 's' | 'S' | 'w' | 'W') => {
                    self.advance_by(2);
                    return Ok(classes_only);
                }
                Some(p @ ('p' | 'P')) => {
                    self.advance_by(2);
                    return match self.property_class(p == 'P') {
                        Some(strings) => Ok(SetOperand { character: None, strings }),
                        None => Err(INVALID_CLASS_PROPERTY_NAME),
                    };
                }
                Some('q') => {
                    self.advance_by(2);
                    let strings = self.class_string_disjunction()?;
                    return Ok(SetOperand { character: None, strings });
                }
                _ => {}
            }
        }
        let character = self.set_character()?;
        Ok(SetOperand { character: Some(character), strings: false })
    }

    /// `ParseClassStringDisjunction`: `{` string `|` string … `}` after `\q`. True when any
    /// string is not exactly one character.
    fn class_string_disjunction(&mut self) -> Fail<bool> {
        if self.current() != 0x7B {
            return Err(INVALID_ESCAPE);
        }
        self.advance();
        let mut strings = false;
        loop {
            let mut length = 0;
            while self.current() != END && self.current() != 0x7C && self.current() != 0x7D {
                self.set_character()?;
                length += 1;
            }
            strings |= length != 1;
            match self.current() {
                0x7C => self.advance(),
                0x7D => {
                    self.advance();
                    return Ok(strings);
                }
                _ => return Err(UNTERMINATED_CHARACTER_CLASS),
            }
        }
    }

    /// `ParseClassSetCharacter`.
    fn set_character(&mut self) -> Fail<u32> {
        let c = self.current();
        if c == END {
            return Err(UNTERMINATED_CHARACTER_CLASS);
        }
        if is_class_set_syntax_character(c) && c != 0x5C {
            return Err(INVALID_CHARACTER_IN_CLASS);
        }
        if is_class_set_double_punctuator(c) && self.next() == c {
            return Err(INVALID_CLASS_SET_OPERATION);
        }
        if c == 0x5C {
            return match as_char(self.next()) {
                Some('b') => {
                    self.advance_by(2);
                    Ok(0x08)
                }
                None => Err(ESCAPE_AT_END),
                Some(_) => self.character_escape(InClass::Yes),
            };
        }
        self.advance();
        Ok(c)
    }

    /// `ParseClassAtom`: the character (or `0` for a class escape) and whether it is a class.
    fn class_atom(&mut self) -> Fail<(u32, bool)> {
        let first = self.current();
        if first != 0x5C {
            self.advance();
            return Ok((first, false));
        }
        let next = self.next();
        match as_char(next) {
            Some('w' | 'W' | 'd' | 'D' | 's' | 'S') => {
                self.advance_by(2);
                return Ok((0, true));
            }
            None => return Err(ESCAPE_AT_END),
            Some('p' | 'P') if self.is_unicode() => {
                self.advance_by(2);
                if self.property_class(next == u32::from(b'P')).is_none() {
                    return Err(INVALID_CLASS_PROPERTY_NAME);
                }
                return Ok((0, true));
            }
            _ => {}
        }
        Ok((self.character_escape(InClass::Yes)?, false))
    }

    /// `ParseCharacterEscape`; `current()` is the backslash.
    fn character_escape(&mut self, in_class: InClass) -> Fail<u32> {
        self.advance();
        let c = self.current();
        let ch = as_char(c);
        match ch {
            Some('b') if in_class == InClass::Yes => {
                self.advance();
                Ok(0x08)
            }
            Some('f') => {
                self.advance();
                Ok(0x0C)
            }
            Some('n') => {
                self.advance();
                Ok(0x0A)
            }
            Some('r') => {
                self.advance();
                Ok(0x0D)
            }
            Some('t') => {
                self.advance();
                Ok(0x09)
            }
            Some('v') => {
                self.advance();
                Ok(0x0B)
            }
            Some('c') => {
                let control = self.next();
                let letter = control & !(u32::from(b'A') ^ u32::from(b'a'));
                if (u32::from(b'A')..=u32::from(b'Z')).contains(&letter) {
                    self.advance_by(2);
                    return Ok(control & 0x1F);
                }
                if self.is_unicode() {
                    return Err(INVALID_UNICODE_ESCAPE);
                }
                if in_class == InClass::Yes && (is_digit(control) || control == u32::from(b'_')) {
                    self.advance_by(2);
                    return Ok(control & 0x1F);
                }
                Ok(0x5C)
            }
            Some('0'..='7') => {
                if c == u32::from(b'0') && self.is_unicode() && !is_digit(self.next()) {
                    self.advance();
                    return Ok(0);
                }
                if self.is_unicode() {
                    return Err(INVALID_CLASS_ESCAPE);
                }
                let start = self.pos;
                self.octal_literal();
                Ok(self.src[start..self.pos].iter().fold(0u32, |acc, d| acc * 8 + u32::from(*d) - 0x30))
            }
            Some('x') => {
                self.advance();
                if let Some(value) = self.hex_escape(2) {
                    return Ok(value);
                }
                if self.is_unicode() {
                    return Err(INVALID_ESCAPE);
                }
                Ok(u32::from(b'x'))
            }
            Some('u') => {
                self.advance();
                if let Some(value) = self.unicode_escape() {
                    return Ok(value);
                }
                if self.is_unicode() {
                    return Err(INVALID_UNICODE_ESCAPE);
                }
                Ok(u32::from(b'u'))
            }
            Some('k') if in_class == InClass::Yes && !self.is_unicode() => {
                // An identity escape unless the pattern has named groups.
                if self.has_named_captures(InClass::Yes) {
                    return Err(INVALID_ESCAPE);
                }
                self.advance();
                Ok(c)
            }
            _ => {
                let class_ok = in_class == InClass::Yes
                    && (c == 0x2D || (self.unicode_sets && is_class_set_reserved_punctuator(c)));
                if self.is_unicode() && !is_syntax_character_or_slash(c) && !class_ok {
                    return Err(INVALID_ESCAPE);
                }
                self.advance();
                Ok(c)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `[pattern, flags, message]` rows written by Node 22 (`new RegExp(pattern, flags)`): every
    /// hand-picked case across 22 flag sets plus up to 14 rows from each (message, flags) bucket
    /// of an exhaustive sweep (all strings up to three characters over 38 pattern characters,
    /// four over 16, five over 16 with `u`). `null` is a pattern V8 accepts.
    const ROWS: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("testdata/regex_errors.json");

    fn mismatches(rows: impl Iterator<Item = (String, String, Option<String>)>, limit: usize) -> (usize, usize, Vec<String>) {
        let (mut total, mut count, mut bad) = (0, 0, Vec::new());
        for (pattern, flags, expected) in rows {
            total += 1;
            let got = js_regex_error(&pattern, &flags);
            if got != expected {
                count += 1;
                if bad.len() < limit {
                    bad.push(format!("/{pattern}/{flags}: node {expected:?}, ours {got:?}"));
                }
            }
        }
        (total, count, bad)
    }

    #[test]
    fn deeply_nested_classes_report_a_stack_overflow_instead_of_crashing() {
        let deep = format!("{}{}", "[".repeat(50_000), "]".repeat(50_000));
        assert_eq!(
            js_regex_error(&deep, "v").map(|m| m.rsplit(": ").next().unwrap_or("").to_owned()).as_deref(),
            Some("Maximum call stack size exceeded")
        );
        assert_eq!(js_regex_error(&format!("{}{}", "[".repeat(100), "]".repeat(100)), "v"), None);
    }

    #[test]
    fn error_text_matches_node_on_the_corpus() {
        let rows: Vec<(String, String, Option<String>)> = serde_json::from_str(&ROWS).expect("fixture");
        let (total, count, bad) = mismatches(rows.into_iter(), 40);
        assert!(total > 5000, "{total}");
        assert!(bad.is_empty(), "{count} of {total} differ:\n{}", bad.join("\n"));
    }

    /// The full sweep (millions of rows): set `MIXDOG_JS_REGEX_CORPUS` to the JSONL file the
    /// generator writes.
    #[test]
    #[allow(clippy::disallowed_methods, reason = "developer-run sweep reads a scratch file; no lane in a unit test")]
    fn error_text_matches_node_on_the_full_sweep() {
        let Ok(path) = std::env::var("MIXDOG_JS_REGEX_CORPUS") else {
            return;
        };
        let text = std::fs::read_to_string(path).expect("corpus");
        let rows = text.lines().map(|l| serde_json::from_str::<(String, String, Option<String>)>(l).expect("row"));
        let (total, count, bad) = mismatches(rows, 60);
        assert!(bad.is_empty(), "{count} of {total} rows differ:\n{}", bad.join("\n"));
    }
}
