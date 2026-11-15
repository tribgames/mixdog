//! The MQ arithmetic decoder of JBIG2 (ITU-T T.88 Annex E and G, software conventions) with PDFium's end-of-data
//! handling, and the integer decoders built on it (T.88 Annex A: the IAx procedure and IAID).

/// One row of the probability estimation table (T.88 table E.1).
struct Qe {
    qe: u32,
    nmps: u8,
    nlps: u8,
    switch: bool,
}

const fn q(qe: u32, nmps: u8, nlps: u8, switch: u8) -> Qe {
    Qe {
        qe,
        nmps,
        nlps,
        switch: switch == 1,
    }
}

static QE_TABLE: [Qe; 47] = [
    q(0x5601, 1, 1, 1),
    q(0x3401, 2, 6, 0),
    q(0x1801, 3, 9, 0),
    q(0x0ac1, 4, 12, 0),
    q(0x0521, 5, 29, 0),
    q(0x0221, 38, 33, 0),
    q(0x5601, 7, 6, 1),
    q(0x5401, 8, 14, 0),
    q(0x4801, 9, 14, 0),
    q(0x3801, 10, 14, 0),
    q(0x3001, 11, 17, 0),
    q(0x2401, 12, 18, 0),
    q(0x1c01, 13, 20, 0),
    q(0x1601, 29, 21, 0),
    q(0x5601, 15, 14, 1),
    q(0x5401, 16, 14, 0),
    q(0x5101, 17, 15, 0),
    q(0x4801, 18, 16, 0),
    q(0x3801, 19, 17, 0),
    q(0x3401, 20, 18, 0),
    q(0x3001, 21, 19, 0),
    q(0x2801, 22, 19, 0),
    q(0x2401, 23, 20, 0),
    q(0x2201, 24, 21, 0),
    q(0x1c01, 25, 22, 0),
    q(0x1801, 26, 23, 0),
    q(0x1601, 27, 24, 0),
    q(0x1401, 28, 25, 0),
    q(0x1201, 29, 26, 0),
    q(0x1101, 30, 27, 0),
    q(0x0ac1, 31, 28, 0),
    q(0x09c1, 32, 29, 0),
    q(0x08a1, 33, 30, 0),
    q(0x0521, 34, 31, 0),
    q(0x0441, 35, 32, 0),
    q(0x02a1, 36, 33, 0),
    q(0x0221, 37, 34, 0),
    q(0x0141, 38, 35, 0),
    q(0x0111, 39, 36, 0),
    q(0x0085, 40, 37, 0),
    q(0x0049, 41, 38, 0),
    q(0x0025, 42, 39, 0),
    q(0x0015, 43, 40, 0),
    q(0x0009, 44, 41, 0),
    q(0x0005, 45, 42, 0),
    q(0x0001, 45, 43, 0),
    q(0x5601, 46, 46, 0),
];

/// The state of one coding context: an index into the estimation table and the more probable symbol.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ArithCx {
    index: u8,
    mps: u8,
}

/// The arithmetic decoder over `data` starting at byte `start`. It reads the bytes the way the JBIG2 stream's byte
/// cursor does: past the end every byte is 0xFF. A marker in the data (a 0xFF followed by a byte above 0x8F) does not end
/// it: the decoder goes on from the 1 bits the marker stands for, and only the end of the data completes it.
pub struct ArithDecoder<'a> {
    data: &'a [u8],
    index: u32,
    b: u8,
    c: u32,
    a: u32,
    ct: i32,
    complete: bool,
}

impl<'a> ArithDecoder<'a> {
    /// INITDEC.
    pub fn new(data: &'a [u8], start: u32) -> Self {
        let mut decoder = ArithDecoder {
            data,
            index: start,
            b: 0,
            c: 0,
            a: 0,
            ct: 0,
            complete: false,
        };
        decoder.b = decoder.current_byte();
        decoder.c = u32::from(decoder.b ^ 0xff) << 16;
        decoder.byte_in();
        decoder.c <<= 7;
        decoder.ct -= 7;
        decoder.a = 0x8000;
        decoder
    }

    fn length(&self) -> u32 {
        u32::try_from(self.data.len()).unwrap_or(u32::MAX)
    }

    fn in_bounds(&self) -> bool {
        self.index < self.length()
    }

    fn current_byte(&self) -> u8 {
        if self.in_bounds() {
            self.data[self.index as usize]
        } else {
            0xff
        }
    }

    fn next_byte(&self) -> u8 {
        let next = self.index.wrapping_add(1);
        if next < self.length() {
            self.data[next as usize]
        } else {
            0xff
        }
    }

    /// BYTEIN.
    fn byte_in(&mut self) {
        if self.b == 0xff {
            let b1 = self.next_byte();
            if b1 > 0x8f {
                self.ct = 0xff;
            } else {
                self.advance();
                self.b = b1;
                self.c = self.c.wrapping_add(0xfe00).wrapping_sub(u32::from(self.b) << 9);
                self.ct = 7;
            }
        } else {
            self.advance();
            self.b = self.current_byte();
            self.c = self.c.wrapping_add(0xff00).wrapping_sub(u32::from(self.b) << 8);
            self.ct = 8;
        }
        if !self.in_bounds() {
            self.complete = true;
        }
    }

    fn advance(&mut self) {
        if self.in_bounds() {
            self.index += 1;
        }
    }

    /// RENORMD.
    fn renormalise(&mut self) {
        loop {
            if self.ct == 0 {
                self.byte_in();
            }
            self.a <<= 1;
            self.c <<= 1;
            self.ct -= 1;
            if self.a & 0x8000 != 0 {
                break;
            }
        }
    }

    /// DECODE: the next decision (0 or 1) coded in context `cx`.
    pub fn decode(&mut self, cx: &mut ArithCx) -> u8 {
        let entry = &QE_TABLE[usize::from(cx.index)];
        self.a -= entry.qe;
        if (self.c >> 16) < self.a {
            if self.a & 0x8000 != 0 {
                return cx.mps;
            }
            let bit;
            if self.a < entry.qe {
                bit = 1 - cx.mps;
                if entry.switch {
                    cx.mps = 1 - cx.mps;
                }
                cx.index = entry.nlps;
            } else {
                bit = cx.mps;
                cx.index = entry.nmps;
            }
            self.renormalise();
            bit
        } else {
            self.c -= self.a << 16;
            let bit;
            if self.a < entry.qe {
                bit = cx.mps;
                cx.index = entry.nmps;
            } else {
                bit = 1 - cx.mps;
                if entry.switch {
                    cx.mps = 1 - cx.mps;
                }
                cx.index = entry.nlps;
            }
            self.a = entry.qe;
            self.renormalise();
            bit
        }
    }

    /// True once the decoder has run past the end of the data: the region decoders stop there.
    pub fn is_complete(&self) -> bool {
        self.complete
    }

    /// The byte the stream cursor is at: the marker's first byte when the data is intact.
    pub fn byte_index(&self) -> u32 {
        self.index
    }
}

/// The IAx integer decoder (T.88 A.2) with its 512 contexts.
pub struct ArithIntDecoder {
    contexts: Vec<ArithCx>,
}

impl Default for ArithIntDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// (bits to read, value to add) of the six ranges of the IAx procedure.
const INT_RANGES: [(u32, i32); 6] = [(2, 0), (4, 4), (6, 20), (8, 84), (12, 340), (32, 4436)];

impl ArithIntDecoder {
    pub fn new() -> Self {
        ArithIntDecoder {
            contexts: vec![ArithCx::default(); 512],
        }
    }

    /// The next integer; `None` is the out-of-band value (also what an unrepresentable value reads as).
    pub fn decode(&mut self, decoder: &mut ArithDecoder) -> Option<i32> {
        let mut prev: usize = 1;
        let s = decoder.decode(&mut self.contexts[prev]);
        prev = (prev << 1) | usize::from(s);
        let mut range = 0;
        while range < INT_RANGES.len() - 1 {
            let d = decoder.decode(&mut self.contexts[prev]);
            prev = (prev << 1) | usize::from(d);
            if d == 0 {
                break;
            }
            range += 1;
        }
        let (bits, base) = INT_RANGES[range];
        let mut temp: u32 = 0;
        for _ in 0..bits {
            let d = decoder.decode(&mut self.contexts[prev]);
            prev = (prev << 1) | usize::from(d);
            if prev >= 256 {
                prev = (prev & 511) | 256;
            }
            temp = (temp << 1) | u32::from(d);
        }
        let mut value = base.checked_add(temp as i32)?;
        if s == 1 && value > 0 {
            value = -value;
        }
        if s == 1 && value == 0 {
            return None;
        }
        Some(value)
    }
}

/// The IAID decoder (T.88 A.3): symbol ids of `code_length` bits.
pub struct ArithIaidDecoder {
    code_length: u32,
    contexts: Vec<ArithCx>,
}

impl ArithIaidDecoder {
    pub fn new(code_length: u32) -> Self {
        ArithIaidDecoder {
            code_length,
            contexts: vec![ArithCx::default(); 1usize << code_length.min(30)],
        }
    }

    pub fn decode(&mut self, decoder: &mut ArithDecoder) -> u32 {
        let mut prev: u32 = 1;
        for _ in 0..self.code_length {
            let d = decoder.decode(&mut self.contexts[prev as usize]);
            prev = (prev << 1) | u32::from(d);
        }
        prev.wrapping_sub(1u32 << self.code_length)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// T.88 Annex H.2: the test sequence, coded in one context.
    #[test]
    fn decodes_the_standard_test_sequence() {
        let coded = unhex("84c73bfce1a1430402200000410dbb86f4317fff88ff37471adb6adfffac");
        let expected = unhex("00020051000000c00352872aaaaaaaaa82c02000fcd79ef6bf7fed904f46a3bf");
        let mut decoder = ArithDecoder::new(&coded, 0);
        let mut cx = ArithCx::default();
        let mut out = Vec::new();
        for _ in 0..expected.len() {
            let mut byte = 0u8;
            for _ in 0..8 {
                byte = (byte << 1) | decoder.decode(&mut cx);
            }
            out.push(byte);
        }
        assert_eq!(out, expected);
        assert!(!decoder.is_complete());
    }

    #[test]
    fn data_past_the_end_completes_the_decoder() {
        let mut decoder = ArithDecoder::new(&[0x84], 0);
        let mut cx = ArithCx::default();
        for _ in 0..64 {
            decoder.decode(&mut cx);
        }
        assert!(decoder.is_complete());
        assert_eq!(decoder.byte_index(), 1);
    }
}
