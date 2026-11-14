//! ASCIIHexDecode, as pdf.js `AsciiHexStream`: characters that are not hex digits are skipped, `>` ends the data, and a
//! lone last digit before the `>` is the high nibble of a final byte (`7>` is `0x70`). A lone digit at the end of an
//! input without a `>` is dropped, as pdf.js does.

/// Decodes `input`; the output stops at `limit` bytes.
pub fn decode(input: &[u8], limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut first: Option<u8> = None;
    let mut ended = false;
    for &ch in input {
        let digit = match ch {
            b'0'..=b'9' => ch & 0x0f,
            b'A'..=b'F' | b'a'..=b'f' => (ch & 0x0f) + 9,
            b'>' => {
                ended = true;
                break;
            }
            _ => continue,
        };
        match first.take() {
            None => first = Some(digit),
            Some(high) => out.push((high << 4) | digit),
        }
    }
    if ended && let Some(high) = first {
        out.push(high << 4);
    }
    out.truncate(limit);
    out
}
