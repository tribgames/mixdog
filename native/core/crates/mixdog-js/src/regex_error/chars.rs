use super::*;

pub(super) fn hex_value(c: u32) -> Option<u32> {
    char::from_u32(c)?.to_digit(16).filter(|_| c < 128)
}

/// The character for `c`, `None` at the end of the pattern. A lone surrogate unit (non-Unicode
/// patterns read UTF-16 units) is an ordinary character that matches no special case.
pub(super) fn as_char(c: u32) -> Option<char> {
    (c != END).then(|| char::from_u32(c).unwrap_or('\u{fffd}'))
}

pub(super) fn is_digit(c: u32) -> bool {
    (u32::from(b'0')..=u32::from(b'9')).contains(&c)
}

pub(super) fn is_syntax_character_or_slash(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "^$\\.*+?()[]{}|/".contains(c))
}

/// `ClassSetReservedPunctuator`: escapable inside a `v`-flag class.
pub(super) fn is_class_set_reserved_punctuator(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "&-!#%,:;<=>@`~".contains(c))
}

/// `ClassSetSyntaxCharacter`.
pub(super) fn is_class_set_syntax_character(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "()[]{}/-\\|".contains(c))
}

/// The characters that make a `ClassSetReservedDoublePunctuator` when doubled.
pub(super) fn is_class_set_double_punctuator(c: u32) -> bool {
    char::from_u32(c).is_some_and(|c| "&!#$%*+,.:;<=>?@^`~".contains(c))
}

pub(super) fn is_lead(c: u32) -> bool {
    (0xD800..0xDC00).contains(&c)
}

pub(super) fn is_trail(c: u32) -> bool {
    (0xDC00..0xE000).contains(&c)
}

pub(super) fn property_regex_accepts(source: &str) -> bool {
    regress::Regex::with_flags(source, "u").is_ok()
}

pub(super) fn is_identifier_start(c: u32) -> bool {
    static START: LazyLock<regress::Regex> = LazyLock::new(|| regress::Regex::with_flags(r"^[\p{ID_Start}$_]$", "u").expect("static pattern"));
    char::from_u32(c).is_some_and(|c| START.find(c.encode_utf8(&mut [0; 4])).is_some())
}

pub(super) fn is_identifier_part(c: u32) -> bool {
    static PART: LazyLock<regress::Regex> = LazyLock::new(|| regress::Regex::with_flags(r"^[\p{ID_Continue}$_\u200c\u200d]$", "u").expect("static pattern"));
    char::from_u32(c).is_some_and(|c| PART.find(c.encode_utf8(&mut [0; 4])).is_some())
}
