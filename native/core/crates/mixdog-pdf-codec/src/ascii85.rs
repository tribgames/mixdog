//! ASCII85Decode, as pdf.js `Ascii85Stream`: `z` is four zero bytes, `~` (the start of `~>`) or the end of the input
//! ends the data, and a final group of fewer than five digits is padded with `u` and yields one byte fewer than it
//! has digits.

fn is_white_space(c: u8) -> bool {
    matches!(c, 0x20 | 0x09 | 0x0d | 0x0a)
}

/// Decodes `input`; the output stops at `limit` bytes.
pub fn decode(input: &[u8], limit: usize) -> Vec<u8> {
    const TILDE: u8 = 0x7e;
    const Z_LOWER: u8 = 0x7a;
    let mut out = Vec::new();
    let mut pos = 0usize;
    // The next byte that is not white space; `None` at the end of the input.
    let next = |pos: &mut usize| -> Option<u8> {
        while let Some(&c) = input.get(*pos) {
            *pos += 1;
            if !is_white_space(c) {
                return Some(c);
            }
        }
        None
    };
    while out.len() < limit {
        let Some(c) = next(&mut pos) else { break };
        if c == TILDE {
            break;
        }
        if c == Z_LOWER {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        let mut group = [c, 0, 0, 0, 0];
        let mut count = 1usize;
        let mut ended = false;
        while count < 5 {
            // pdf.js stores the end marker -1 in a byte array: it reads back as 255.
            let c = next(&mut pos);
            group[count] = c.unwrap_or(255);
            if c.is_none() || c == Some(TILDE) {
                ended = true;
                break;
            }
            count += 1;
        }
        if ended {
            group[count..].fill(0x21 + 84);
        }
        let mut t: i64 = 0;
        for &digit in &group {
            t = t * 85 + (i64::from(digit) - 0x21);
        }
        // The sum is taken as a 32-bit integer, as JavaScript does for `& 0xff` and `>>`.
        let mut t = t as i32;
        let mut bytes = [0u8; 4];
        for slot in bytes.iter_mut().rev() {
            *slot = (t & 0xff) as u8;
            t >>= 8;
        }
        let keep = if ended { count - 1 } else { 4 };
        out.extend_from_slice(&bytes[..keep]);
        if ended {
            break;
        }
    }
    out.truncate(limit);
    out
}
