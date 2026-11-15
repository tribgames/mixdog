//! Routing identifiers handed out to phone legs and stored as device ids: one predicate so every decoder, store row
//! and HTTP handler agrees on the same shape (`lib/ids.mjs`, `lib/device-store-auth.mjs`).

/// `^[0-9a-f-]{8,64}$`: eight to sixty-four lowercase hex digits or dashes.
pub fn is_routing_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// A device id a desktop may register: a lowercase UUID (`8-4-4-4-12`) or thirty-two to sixty-four lowercase hex digits.
pub fn is_registrable_device_id(value: &str) -> bool {
    let hex = |part: &str| part.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if (32..=64).contains(&value.len()) && hex(value) {
        return true;
    }
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5 && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, len)| part.len() == len && hex(part))
}
