//! LZWDecode, as pdf.js `LZWStream` (the weezl crate is not used: it does not give pdf.js's output on the end of a
//! stream with no end-of-data code or on an `EarlyChange` other than 0 and 1).
//!
//! Codes are 9 to 12 bits, most significant bit first; 256 clears the table, 257 ends the data. The code width grows
//! when the next table slot, plus `EarlyChange`, reaches a power of two. The decoding goes block by block of 512
//! codes, as pdf.js does, and that is visible on one input: when the data ends without a 257, the codes the input no
//! longer has read as the literal byte 0 up to the end of the block of 512 codes the end fell in.

const BLOCK_CODES: usize = 512;
const DICTIONARY_SIZE: usize = 4096;

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    cached: u32,
    bits: u32,
    eof: bool,
}

impl BitReader<'_> {
    /// The next `n` bits; `None` (and `eof` set) when the input has no more.
    fn read(&mut self, n: u32) -> Option<u32> {
        while self.bits < n {
            let Some(&c) = self.data.get(self.pos) else {
                self.eof = true;
                return None;
            };
            self.pos += 1;
            self.cached = (self.cached << 8) | u32::from(c);
            self.bits += 8;
        }
        self.bits -= n;
        Some((self.cached >> self.bits) & 1u32.wrapping_shl(n).wrapping_sub(1))
    }
}

/// Decodes `input` with the given `EarlyChange` (1 when the stream has none); output exceeding `limit` returns `ResourceLimit`.
pub fn decode(input: &[u8], early_change: i64, limit: usize) -> Result<Vec<u8>, crate::CodecError> {
    crate::check_output(decode_prefix(input, early_change, limit.saturating_add(1)), limit)
}

fn decode_prefix(input: &[u8], early_change: i64, limit: usize) -> Vec<u8> {
    let mut reader = BitReader { data: input, pos: 0, cached: 0, bits: 0, eof: false };
    let mut values = [0u8; DICTIONARY_SIZE];
    let mut lengths = [0u16; DICTIONARY_SIZE];
    let mut prev_codes = [0u16; DICTIONARY_SIZE];
    for (i, value) in values.iter_mut().enumerate().take(256) {
        *value = i as u8;
    }
    lengths[..256].fill(1);
    let mut current = [0u8; DICTIONARY_SIZE];
    let mut current_len = 0usize;
    let mut next_code = 258usize;
    let mut code_length = 9u32;
    let mut prev_code = 0usize;
    let mut out = Vec::new();
    let mut ended = false;
    while !ended && !reader.eof && out.len() < limit {
        for _ in 0..BLOCK_CODES {
            // A code the input does not have is `null` in pdf.js, which compares below 256 and stores as 0.
            let code = reader.read(code_length).unwrap_or(0) as usize;
            let has_prev = current_len > 0;
            if code < 256 {
                current[0] = code as u8;
                current_len = 1;
            } else if code >= 258 {
                if code < next_code {
                    current_len = usize::from(lengths[code]);
                    let mut q = code;
                    for j in (0..current_len).rev() {
                        if let Some(slot) = current.get_mut(j) {
                            *slot = values[q];
                        }
                        q = usize::from(prev_codes[q]);
                    }
                } else {
                    if let Some(first) = current.first().copied()
                        && let Some(slot) = current.get_mut(current_len)
                    {
                        *slot = first;
                    }
                    current_len += 1;
                }
            } else if code == 256 {
                code_length = 9;
                next_code = 258;
                current_len = 0;
                continue;
            } else {
                ended = true;
                break;
            }
            if has_prev {
                if next_code < DICTIONARY_SIZE {
                    prev_codes[next_code] = prev_code as u16;
                    lengths[next_code] = lengths[prev_code].wrapping_add(1);
                    values[next_code] = current[0];
                }
                next_code += 1;
                let x = (next_code as i64 + early_change) as i32;
                if (x & x.wrapping_sub(1)) == 0 {
                    code_length = if x > 0 { (x.trailing_zeros() + 1).min(12) } else { 0 };
                }
            }
            prev_code = code;
            out.extend((0..current_len).map(|j| current.get(j).copied().unwrap_or(0)));
            if out.len() >= limit {
                break;
            }
        }
    }
    out.truncate(limit);
    out
}
