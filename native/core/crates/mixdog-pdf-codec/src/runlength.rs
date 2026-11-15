//! RunLengthDecode, as pdf.js `RunLengthStream`: a length byte below 128 copies that many plus one bytes, one above
//! 128 repeats the next byte `257 - n` times, 128 ends the data. A copy cut short by the end of the input is padded
//! with zero bytes to its declared length.

/// Decodes `input`; output exceeding `limit` returns `ResourceLimit`.
pub fn decode(input: &[u8], limit: usize) -> Result<Vec<u8>, crate::CodecError> {
    crate::check_output(decode_prefix(input, limit.saturating_add(1)), limit)
}

fn decode_prefix(input: &[u8], limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while out.len() < limit {
        let (Some(&n), Some(&value)) = (input.get(pos), input.get(pos + 1)) else {
            break;
        };
        if n == 128 {
            break;
        }
        pos += 2;
        if n < 128 {
            out.push(value);
            let want = usize::from(n);
            let take = want.min(input.len() - pos);
            out.extend_from_slice(&input[pos..pos + take]);
            pos += take;
            out.resize(out.len() + (want - take), 0);
        } else {
            out.resize(out.len() + (257 - usize::from(n)), value);
        }
    }
    out.truncate(limit);
    out
}
