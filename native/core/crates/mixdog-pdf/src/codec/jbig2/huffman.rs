//! Huffman tables of JBIG2 (T.88 Annex B) as PDFium's `CJBig2_HuffmanTable` and `CJBig2_HuffmanDecoder` carry them
//! out: the fifteen standard tables, tables coded in a table segment (type 53), and the decoding of one value
//! (a range's offset added to its low end, the lower range subtracted from its end, or the out-of-band value).

use super::BitStream;

/// One line of a table: the prefix code (`len` bits, 0 = unused) of a range.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Code {
    pub len: u32,
    pub code: u32,
}

/// What a value of a table decodes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coded {
    Value(i32),
    /// The out-of-band value (JBIG2_OOB).
    Oob,
}

impl Coded {
    /// The value, or `None` for the out-of-band value: where the decoder takes anything but a value as a failure.
    pub fn value(self) -> Option<i32> {
        match self {
            Coded::Value(v) => Some(v),
            Coded::Oob => None,
        }
    }
}

/// A table: per line the prefix code, the number of offset bits and the low end of the range. The lines are the
/// ranges, then the lower range, the upper range and (when `oob`) the out-of-band line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HuffmanTable {
    codes: Vec<Code>,
    range_len: Vec<u32>,
    range_low: Vec<i32>,
    oob: bool,
}

struct Standard {
    oob: bool,
    /// (prefix length, range length, range low) per line.
    lines: &'static [(u32, u32, i32)],
}

/// Tables B.1 to B.15. A table without a lower or an upper range has an unused line (prefix length 0) in its place.
static STANDARD: [Standard; 15] = [
    // B.1
    Standard { oob: false, lines: &[(1, 4, 0), (2, 8, 16), (3, 16, 272), (0, 32, -1), (3, 32, 65808)] },
    // B.2
    Standard { oob: true, lines: &[(1, 0, 0), (2, 0, 1), (3, 0, 2), (4, 3, 3), (5, 6, 11), (0, 32, -1), (6, 32, 75), (6, 0, 0)] },
    // B.3
    Standard { oob: true, lines: &[(8, 8, -256), (1, 0, 0), (2, 0, 1), (3, 0, 2), (4, 3, 3), (5, 6, 11), (8, 32, -257), (7, 32, 75), (6, 0, 0)] },
    // B.4
    Standard { oob: false, lines: &[(1, 0, 1), (2, 0, 2), (3, 0, 3), (4, 3, 4), (5, 6, 12), (0, 32, 0), (5, 32, 76)] },
    // B.5
    Standard { oob: false, lines: &[(7, 8, -255), (1, 0, 1), (2, 0, 2), (3, 0, 3), (4, 3, 4), (5, 6, 12), (7, 32, -256), (6, 32, 76)] },
    // B.6
    Standard {
        oob: false,
        lines: &[
            (5, 10, -2048),
            (4, 9, -1024),
            (4, 8, -512),
            (4, 7, -256),
            (5, 6, -128),
            (5, 5, -64),
            (4, 5, -32),
            (2, 7, 0),
            (3, 7, 128),
            (3, 8, 256),
            (4, 9, 512),
            (4, 10, 1024),
            (6, 32, -2049),
            (6, 32, 2048),
        ],
    },
    // B.7
    Standard {
        oob: false,
        lines: &[
            (4, 9, -1024),
            (3, 8, -512),
            (4, 7, -256),
            (5, 6, -128),
            (5, 5, -64),
            (4, 5, -32),
            (4, 5, 0),
            (5, 5, 32),
            (5, 6, 64),
            (4, 7, 128),
            (3, 8, 256),
            (3, 9, 512),
            (3, 10, 1024),
            (5, 32, -1025),
            (5, 32, 2048),
        ],
    },
    // B.8
    Standard {
        oob: true,
        lines: &[
            (8, 3, -15),
            (9, 1, -7),
            (8, 1, -5),
            (9, 0, -3),
            (7, 0, -2),
            (4, 0, -1),
            (2, 1, 0),
            (5, 0, 2),
            (6, 0, 3),
            (3, 4, 4),
            (6, 1, 20),
            (4, 4, 22),
            (4, 5, 38),
            (5, 6, 70),
            (5, 7, 134),
            (6, 7, 262),
            (7, 8, 390),
            (6, 10, 646),
            (9, 32, -16),
            (9, 32, 1670),
            (2, 0, 0),
        ],
    },
    // B.9
    Standard {
        oob: true,
        lines: &[
            (8, 4, -31),
            (9, 2, -15),
            (8, 2, -11),
            (9, 1, -7),
            (7, 1, -5),
            (4, 1, -3),
            (3, 1, -1),
            (3, 1, 1),
            (5, 1, 3),
            (6, 1, 5),
            (3, 5, 7),
            (6, 2, 39),
            (4, 5, 43),
            (4, 6, 75),
            (5, 7, 139),
            (5, 8, 267),
            (6, 8, 523),
            (7, 9, 779),
            (6, 11, 1291),
            (9, 32, -32),
            (9, 32, 3339),
            (2, 0, 0),
        ],
    },
    // B.10
    Standard {
        oob: true,
        lines: &[
            (7, 4, -21),
            (8, 0, -5),
            (7, 0, -4),
            (5, 0, -3),
            (2, 2, -2),
            (5, 0, 2),
            (6, 0, 3),
            (7, 0, 4),
            (8, 0, 5),
            (2, 6, 6),
            (5, 5, 70),
            (6, 5, 102),
            (6, 6, 134),
            (6, 7, 198),
            (6, 8, 326),
            (6, 9, 582),
            (6, 10, 1094),
            (7, 11, 2118),
            (8, 32, -22),
            (8, 32, 4166),
            (2, 0, 0),
        ],
    },
    // B.11
    Standard {
        oob: false,
        lines: &[
            (1, 0, 1),
            (2, 1, 2),
            (4, 0, 4),
            (4, 1, 5),
            (5, 1, 7),
            (5, 2, 9),
            (6, 2, 13),
            (7, 2, 17),
            (7, 3, 21),
            (7, 4, 29),
            (7, 5, 45),
            (7, 6, 77),
            (0, 32, 0),
            (7, 32, 141),
        ],
    },
    // B.12
    Standard {
        oob: false,
        lines: &[
            (1, 0, 1),
            (2, 0, 2),
            (3, 1, 3),
            (5, 0, 5),
            (5, 1, 6),
            (6, 1, 8),
            (7, 0, 10),
            (7, 1, 11),
            (7, 2, 13),
            (7, 3, 17),
            (7, 4, 25),
            (8, 5, 41),
            (0, 32, 0),
            (8, 32, 73),
        ],
    },
    // B.13
    Standard {
        oob: false,
        lines: &[
            (1, 0, 1),
            (3, 0, 2),
            (4, 0, 3),
            (5, 0, 4),
            (4, 1, 5),
            (3, 3, 7),
            (6, 1, 15),
            (6, 2, 17),
            (6, 3, 21),
            (6, 4, 29),
            (6, 5, 45),
            (7, 6, 77),
            (0, 32, 0),
            (7, 32, 141),
        ],
    },
    // B.14
    Standard { oob: false, lines: &[(3, 0, -2), (3, 0, -1), (1, 0, 0), (3, 0, 1), (3, 0, 2), (0, 32, -3), (0, 32, 3)] },
    // B.15
    Standard {
        oob: false,
        lines: &[
            (7, 4, -24),
            (6, 2, -8),
            (5, 1, -4),
            (4, 0, -2),
            (3, 0, -1),
            (1, 0, 0),
            (3, 0, 1),
            (4, 0, 2),
            (5, 1, 3),
            (6, 2, 5),
            (7, 4, 9),
            (7, 32, -25),
            (7, 32, 25),
        ],
    },
];

/// `HuffmanAssignCode`: the codes (T.88 B.3) of the prefix lengths in `codes`, in line order. `None` when a first
/// code does not fit 31 bits.
fn assign_codes(codes: &mut [Code]) -> Option<()> {
    let max_len = codes.iter().map(|c| c.len).max().unwrap_or(0) as usize;
    let mut count = vec![0i32; max_len + 1];
    for c in codes.iter() {
        count[c.len as usize] += 1;
    }
    count[0] = 0;
    let mut first = vec![0i32; max_len + 1];
    for len in 1..=max_len {
        first[len] = first[len - 1].checked_add(count[len - 1])?.checked_mul(2)?;
        let mut current = first[len];
        for c in codes.iter_mut().filter(|c| c.len as usize == len) {
            c.code = current as u32;
            current = current.wrapping_add(1);
        }
    }
    Some(())
}

/// The prefix codes of `codes` assigned by [`assign_codes`], as the symbol-id table of a text region needs them.
pub fn assigned(mut codes: Vec<Code>) -> Option<Vec<Code>> {
    assign_codes(&mut codes)?;
    Some(codes)
}

impl HuffmanTable {
    /// Standard table B.`index` (1 to 15).
    pub fn standard(index: usize) -> HuffmanTable {
        let table = &STANDARD[index - 1];
        let mut codes: Vec<Code> = table.lines.iter().map(|&(len, _, _)| Code { len, code: 0 }).collect();
        assign_codes(&mut codes).expect("the standard tables have short prefixes");
        HuffmanTable {
            codes,
            range_len: table.lines.iter().map(|&(_, r, _)| r).collect(),
            range_low: table.lines.iter().map(|&(_, _, l)| l).collect(),
            oob: table.oob,
        }
    }

    /// `ParseFromCodedBuffer` (T.88 B.2): the table of a table segment, read from `stream`. `None` when it is
    /// malformed or the data ends.
    pub fn parse(stream: &mut BitStream) -> Option<HuffmanTable> {
        let flags = stream.read_u8()?;
        let oob = flags & 1 != 0;
        let prefix_bits = u32::from((flags >> 1) & 7) + 1;
        let range_bits = u32::from((flags >> 4) & 7) + 1;
        let low = stream.read_u32()? as i32;
        let high = stream.read_u32()? as i32;
        if low > high {
            return None;
        }
        let mut codes = Vec::new();
        let mut range_len = Vec::new();
        let mut range_low = Vec::new();
        let mut current = low;
        loop {
            codes.push(Code { len: stream.read_nbits(prefix_bits)?, code: 0 });
            let len = stream.read_nbits(range_bits)?;
            range_len.push(len);
            range_low.push(current);
            current = current.checked_add(1i32.checked_shl(len)?)?;
            if current >= high {
                break;
            }
        }
        codes.push(Code { len: stream.read_nbits(prefix_bits)?, code: 0 });
        range_len.push(32);
        range_low.push(low.wrapping_sub(1));
        codes.push(Code { len: stream.read_nbits(prefix_bits)?, code: 0 });
        range_len.push(32);
        range_low.push(high);
        if oob {
            codes.push(Code { len: stream.read_nbits(prefix_bits)?, code: 0 });
            range_len.push(0);
            range_low.push(0);
        }
        assign_codes(&mut codes)?;
        Some(HuffmanTable { codes, range_len, range_low, oob })
    }

    /// `DecodeAValue`: the next value from the bits of `stream`. `None` when the data ends before a code is complete.
    pub fn decode(&self, stream: &mut BitStream) -> Option<Coded> {
        let longest = self.codes.iter().map(|c| c.len).max().unwrap_or(0);
        let mut value = 0u32;
        let mut bits = 0u32;
        while bits < longest {
            value = (value << 1) | stream.read_1bit()?;
            bits += 1;
            let Some(i) = self.codes.iter().position(|c| c.len == bits && c.code == value) else {
                continue;
            };
            if self.oob && i == self.codes.len() - 1 {
                return Some(Coded::Oob);
            }
            let offset = stream.read_nbits(self.range_len[i])?;
            let lower_range = i == self.codes.len() - if self.oob { 3 } else { 2 };
            let low = self.range_low[i];
            return Some(Coded::Value(if lower_range { low.wrapping_sub(offset as i32) } else { low.wrapping_add(offset as i32) }));
        }
        None
    }
}

impl BitStream<'_> {
    /// `read1Bit`: the next bit, or `None` at the end of the data.
    pub fn read_1bit(&mut self) -> Option<u32> {
        let byte = self.peek_u8()?;
        let bit = u32::from(byte >> (7 - self.bit_index)) & 1;
        if self.bit_index == 7 {
            self.byte_index += 1;
            self.bit_index = 0;
        } else {
            self.bit_index += 1;
        }
        Some(bit)
    }

    /// `readNBits`: the next `bits` bits as a number; fewer are read when the data ends within them, none left at all
    /// is a failure.
    pub fn read_nbits(&mut self, bits: u32) -> Option<u32> {
        self.peek_u8()?;
        let total = self.data.len() * 8;
        let position = self.bit_position();
        let count = (bits as usize).min(total - position);
        let mut value = 0u32;
        for _ in 0..count {
            value = (value << 1) | self.read_1bit()?;
        }
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bit string written most significant bit first.
    struct Bits(Vec<u8>, usize);

    impl Bits {
        fn new() -> Self {
            Bits(Vec::new(), 0)
        }

        fn push(&mut self, value: u32, len: u32) {
            for i in (0..len).rev() {
                if self.1 % 8 == 0 {
                    self.0.push(0);
                }
                if (value >> i) & 1 == 1 {
                    *self.0.last_mut().unwrap() |= 0x80 >> (self.1 % 8);
                }
                self.1 += 1;
            }
        }
    }

    #[test]
    fn standard_tables_are_complete_prefix_codes() {
        for index in 1..=15 {
            let table = HuffmanTable::standard(index);
            let kraft: f64 = table.codes.iter().filter(|c| c.len > 0).map(|c| 0.5f64.powi(c.len as i32)).sum();
            assert!((kraft - 1.0).abs() < 1e-12, "B.{index}");
        }
    }

    #[test]
    fn decodes_ranges_the_lower_range_and_oob() {
        let table = HuffmanTable::standard(3);
        let mut bits = Bits::new();
        bits.push(0x0, 1); // {1,0,0}: value 0
        bits.push(0xe, 4); // {4,3,3}: 3 + offset
        bits.push(5, 3);
        bits.push(0xff, 8); // lower range, offset of 32 bits
        bits.push(300, 32);
        bits.push(0x3e, 6); // OOB
        let mut stream = BitStream::new(&bits.0);
        assert_eq!(table.decode(&mut stream), Some(Coded::Value(0)));
        assert_eq!(table.decode(&mut stream), Some(Coded::Value(8)));
        assert_eq!(table.decode(&mut stream), Some(Coded::Value(-257 - 300)));
        assert_eq!(table.decode(&mut stream), Some(Coded::Oob));
        // the first padding bit is a value 0; with the second the data is used up and reading its (empty) offset fails
        assert_eq!(table.decode(&mut stream), Some(Coded::Value(0)));
        assert_eq!(table.decode(&mut stream), None);
    }

    #[test]
    fn a_table_without_lower_range_keeps_the_upper_range_additive() {
        let table = HuffmanTable::standard(1);
        let mut bits = Bits::new();
        bits.push(0x7, 3); // the upper range of B.1
        bits.push(10, 32);
        let mut stream = BitStream::new(&bits.0);
        assert_eq!(table.decode(&mut stream), Some(Coded::Value(65808 + 10)));
    }

    #[test]
    fn parses_a_table_segment() {
        // HTOOB 1, HTPS 3 bits, HTRS 2 bits, range 0..4: one line of 2 offset bits, then lower, upper and OOB
        let mut data = vec![(1 << 4) | (2 << 1) | 1];
        data.extend_from_slice(&0i32.to_be_bytes());
        data.extend_from_slice(&4i32.to_be_bytes());
        let mut body = Bits::new();
        body.push(1, 3); // prefix length 1
        body.push(2, 2); // 2 offset bits
        body.push(2, 3); // lower range: prefix length 2
        body.push(3, 3); // upper range: prefix length 3
        body.push(3, 3); // OOB: prefix length 3
        data.extend_from_slice(&body.0);
        let mut stream = BitStream::new(&data);
        let table = HuffmanTable::parse(&mut stream).unwrap();
        assert!(table.oob);
        assert_eq!(table.range_low, [0, -1, 4, 0]);
        assert_eq!(table.codes.iter().map(|c| (c.len, c.code)).collect::<Vec<_>>(), [(1, 0), (2, 2), (3, 6), (3, 7)]);
        let mut input = Bits::new();
        input.push(0, 1);
        input.push(3, 2);
        input.push(0x7, 3);
        let mut stream = BitStream::new(&input.0);
        assert_eq!(table.decode(&mut stream), Some(Coded::Value(3)));
        assert_eq!(table.decode(&mut stream), Some(Coded::Oob));
        let mut short = BitStream::new(&data[..6]);
        assert!(HuffmanTable::parse(&mut short).is_none());
        let mut backwards = vec![0u8];
        backwards.extend_from_slice(&5i32.to_be_bytes());
        backwards.extend_from_slice(&1i32.to_be_bytes());
        assert!(HuffmanTable::parse(&mut BitStream::new(&backwards)).is_none());
    }

    #[test]
    fn bit_reads_stop_at_the_end_of_the_data() {
        let mut stream = BitStream::new(&[0b1010_0000]);
        assert_eq!(stream.read_nbits(4), Some(0b1010));
        assert_eq!(stream.read_nbits(32), Some(0));
        assert_eq!(stream.read_1bit(), None);
        assert_eq!(stream.read_nbits(1), None);
    }
}
