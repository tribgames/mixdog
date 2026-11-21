use super::*;

/// ID_Start of ECMAScript: XID_Start and the characters Unicode adds to it as Other_ID_Start.
pub(super) fn id_start(c: char) -> bool {
    c == '$' || c == '_' || unicode_ident::is_xid_start(c) || matches!(c, '\u{1885}' | '\u{1886}' | '\u{2118}' | '\u{212E}' | '\u{309B}' | '\u{309C}')
}

/// ID_Continue of ECMAScript: XID_Continue, the joiners and Other_ID_Continue.
pub(super) fn id_continue(c: char) -> bool {
    id_start(c)
        || c == '\u{200C}'
        || c == '\u{200D}'
        || unicode_ident::is_xid_continue(c)
        || matches!(c, '\u{00B7}' | '\u{0387}' | '\u{1369}'..='\u{1371}' | '\u{19DA}')
}

/// The characters of a name with its `\u0061` and `\u{61}` escapes decoded; `None` when an escape is malformed.
pub(super) fn decoded_name(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        if chars.next() != Some('u') {
            return None;
        }
        let mut digits = String::new();
        if chars.peek() == Some(&'{') {
            chars.next();
            loop {
                match chars.next() {
                    Some('}') => break,
                    Some(d) if d.is_ascii_hexdigit() => digits.push(d),
                    _ => return None,
                }
            }
        } else {
            for _ in 0..4 {
                match chars.next() {
                    Some(d) if d.is_ascii_hexdigit() => digits.push(d),
                    _ => return None,
                }
            }
        }
        out.push(u32::from_str_radix(&digits, 16).ok().and_then(char::from_u32)?);
    }
    Some(out)
}

/// A name as the lexer reads it: an escape stands for the character it spells, which must itself be one a name may
/// start with (or continue with).
pub(super) fn ident_ok(text: &str) -> bool {
    let Some(name) = decoded_name(text) else { return false };
    let mut chars = name.chars();
    chars.next().is_some_and(id_start) && chars.all(id_continue)
}

pub(super) fn check_binding_name(text: &str, strict: bool) -> Check {
    if strict {
        if text == "eval" || text == "arguments" {
            return Err(Reason::Msg(msg::STRICT_EVAL_ARGUMENTS));
        }
        if STRICT_RESERVED.contains(&text) {
            return Err(Reason::Msg(msg::STRICT_RESERVED));
        }
    }
    Ok(())
}

/// A group `(?` that is not a non-capturing group, a look-around or a named group: the modifiers `(?i:` the engine
/// of Node does not read.
pub(super) fn has_group_modifiers(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut at = 0;
    let mut in_class = false;
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 1,
            '[' => in_class = true,
            ']' => in_class = false,
            '(' if !in_class && chars.get(at + 1) == Some(&'?') => {
                let ok = match chars.get(at + 2) {
                    Some(':' | '=' | '!') => true,
                    Some('<') => matches!(chars.get(at + 3), Some('=' | '!')) || chars.get(at + 3).is_some_and(|c| *c != '>'),
                    _ => false,
                };
                if !ok {
                    return true;
                }
            }
            _ => {}
        }
        at += 1;
    }
    false
}

pub(super) fn unicode_escape_ok(rest: &str) -> bool {
    if let Some(braced) = rest.strip_prefix('{') {
        let Some(digits) = braced.strip_suffix('}') else { return false };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let significant = digits.trim_start_matches('0');
        return significant.is_empty() || (significant.len() <= 6 && u32::from_str_radix(significant, 16).is_ok_and(|v| v <= 0x10_FFFF));
    }
    rest.len() == 4 && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Digits of one run with single separators between digits: the count, or None when a separator is misplaced.
pub(super) fn scan_digits(bytes: &[u8], at: &mut usize, radix_ok: fn(u8) -> bool) -> Option<usize> {
    let mut count = 0;
    let mut after_separator = false;
    while let Some(&c) = bytes.get(*at) {
        if radix_ok(c) {
            count += 1;
            after_separator = false;
        } else if c == b'_' {
            if count == 0 || after_separator {
                return None;
            }
            after_separator = true;
        } else {
            break;
        }
        *at += 1;
    }
    if after_separator {
        return None;
    }
    Some(count)
}

pub(super) fn decimal_digit(c: u8) -> bool {
    c.is_ascii_digit()
}

pub(super) fn hex_digit(c: u8) -> bool {
    c.is_ascii_hexdigit()
}

pub(super) fn octal_digit(c: u8) -> bool {
    (b'0'..=b'7').contains(&c)
}

pub(super) fn binary_digit(c: u8) -> bool {
    c == b'0' || c == b'1'
}

/// A numeric literal's own validity (separators, legacy octal, BigInt suffix).
pub(super) fn number_error(text: &str, strict: bool) -> Check {
    let invalid = || Err(Reason::Msg(msg::INVALID_TOKEN));
    let separator = || Err(Reason::Msg(msg::NUMERIC_SEPARATOR));
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return invalid();
    }
    if bytes[0] == b'0' && matches!(bytes.get(1), Some(b'x' | b'X' | b'o' | b'O' | b'b' | b'B')) {
        let radix_ok: fn(u8) -> bool = match bytes[1] {
            b'x' | b'X' => hex_digit,
            b'o' | b'O' => octal_digit,
            _ => binary_digit,
        };
        let mut at = 2;
        let Some(count) = scan_digits(bytes, &mut at, radix_ok) else { return separator() };
        if count == 0 {
            return invalid();
        }
        if bytes.get(at) == Some(&b'n') {
            at += 1;
        }
        return if at == bytes.len() { Ok(()) } else { invalid() };
    }
    if bytes[0] == b'0' && bytes.get(1).is_some_and(|c| c.is_ascii_digit() || *c == b'_') {
        if bytes[1] == b'_' {
            return separator();
        }
        if strict {
            return Err(Reason::Msg(msg::STRICT_OCTAL));
        }
        if bytes.contains(&b'_') {
            return separator();
        }
        let digits = bytes.iter().take_while(|c| c.is_ascii_digit()).count();
        if bytes[..digits].iter().all(|c| octal_digit(*c)) {
            // Legacy octal: nothing may follow the digits.
            return if digits == bytes.len() { Ok(()) } else { invalid() };
        }
        // A leading zero followed by an 8 or 9 is a decimal; it has no BigInt form.
        if bytes.contains(&b'n') {
            return invalid();
        }
    }
    let mut at = 0;
    let mut fraction_or_exponent = false;
    if bytes[0] == b'.' {
        at = 1;
        let Some(count) = scan_digits(bytes, &mut at, decimal_digit) else { return separator() };
        if count == 0 {
            return invalid();
        }
        fraction_or_exponent = true;
    } else {
        let Some(count) = scan_digits(bytes, &mut at, decimal_digit) else { return separator() };
        if count == 0 {
            return invalid();
        }
        if bytes.get(at) == Some(&b'.') {
            at += 1;
            fraction_or_exponent = true;
            if bytes.get(at) == Some(&b'_') {
                return separator();
            }
            if scan_digits(bytes, &mut at, decimal_digit).is_none() {
                return separator();
            }
        }
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        fraction_or_exponent = true;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let Some(count) = scan_digits(bytes, &mut at, decimal_digit) else { return separator() };
        if count == 0 {
            return invalid();
        }
    }
    if bytes.get(at) == Some(&b'n') && !fraction_or_exponent {
        at += 1;
    }
    if at == bytes.len() { Ok(()) } else { invalid() }
}
