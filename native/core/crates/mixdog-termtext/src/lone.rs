//! Half of a UTF-16 surrogate pair inside a Rust string.
//!
//! Node cuts text at UTF-16 units, so a cut can leave half of a pair at the end of one line and half at the start of
//! the next. A JavaScript string holds such a half and measures it as zero cells (`\p{Surrogate}` is not visible to
//! string-width); a Rust `String` cannot hold it. While text is still being cut, joined and measured, a lone half is
//! carried as a code point of plane 16's private use area (U+10F000 to U+10F7FF, one for each of the 2048 surrogate
//! values: no icon font and no noncharacter lives there), which [`crate::width::string_width`] measures as zero cells; [`replace_carriers`] turns each
//! carrier into U+FFFD, which is what Node writes to a terminal for a lone half, once the text is final.

/// The first carrier: the carrier of U+D800.
const CARRIER_BASE: u32 = 0x10f000;
const CARRIER_END: u32 = CARRIER_BASE + 0x800;

/// The code point that carries the lone surrogate `unit` (0xD800 to 0xDFFF).
pub fn carrier_of(unit: u16) -> char {
    char::from_u32(CARRIER_BASE + u32::from(unit) - 0xd800).unwrap_or('\u{fffd}')
}

/// Whether `ch` carries a lone surrogate.
pub fn is_carrier(ch: char) -> bool {
    (CARRIER_BASE..CARRIER_END).contains(&u32::from(ch))
}

/// The UTF-16 units `ch` takes in a JavaScript string: one for a carrier (the lone surrogate it carries), else its own.
pub fn units_of(ch: char) -> usize {
    if is_carrier(ch) { 1 } else { ch.len_utf16() }
}

/// `text.length`: the UTF-16 units of `text`, a carrier as the one unit of the lone surrogate it carries.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(units_of).sum()
}

/// `text` as the store takes it: each carrier is U+FFFD, which is what Node writes for a lone surrogate.
pub fn stored(text: &str) -> std::borrow::Cow<'_, str> {
    if text.chars().any(is_carrier) { std::borrow::Cow::Owned(replace_carriers(text)) } else { std::borrow::Cow::Borrowed(text) }
}

/// The UTF-16 units of `text`, a carrier as the lone surrogate it carries.
pub fn to_units(text: &str) -> Vec<u16> {
    let mut units = Vec::with_capacity(text.len());
    let mut buf = [0u16; 2];
    for ch in text.chars() {
        if is_carrier(ch) {
            units.push((u32::from(ch) - CARRIER_BASE + 0xd800) as u16);
        } else {
            units.extend_from_slice(ch.encode_utf16(&mut buf));
        }
    }
    units
}

/// The string of UTF-16 `units`, each lone surrogate as its carrier.
pub fn from_units(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|decoded| decoded.unwrap_or_else(|error| carrier_of(error.unpaired_surrogate())))
        .collect()
}

/// `text` with each carrier replaced by U+FFFD.
pub fn replace_carriers(text: &str) -> String {
    if !text.chars().any(is_carrier) {
        return text.to_owned();
    }
    text.chars().map(|ch| if is_carrier(ch) { '\u{fffd}' } else { ch }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lone_half_round_trips_through_its_carrier() {
        let units = [0x61, 0xd83d, 0x20, 0xde42, 0xd83d, 0xde42];
        let text = from_units(&units);
        assert_eq!(text.chars().filter(|&c| is_carrier(c)).count(), 2);
        assert_eq!(to_units(&text), units);
        assert_eq!(replace_carriers(&text), "a\u{fffd} \u{fffd}\u{1f642}");
    }

    #[test]
    fn a_carrier_is_one_unit_long() {
        let text = from_units(&[0x61, 0xd83d, 0xd83d, 0xde42]);
        assert_eq!(utf16_len(&text), 4);
        assert_eq!(stored(&text), "a�🙂");
        assert_eq!(stored("plain"), "plain");
    }

    #[test]
    fn a_carrier_takes_no_cell() {
        assert_eq!(crate::display_width_with(&from_units(&[0xd83d]), false), 0);
        assert_eq!(crate::display_width_with(&from_units(&[0x61, 0xde42, 0x62]), false), 2);
    }
}
