//! FlateDecode: the inflate of pdf.js `FlateStream`, with its tolerance of damaged data.
//!
//! A header pdf.js rejects is an error. After the header, damage never fails the stream: the bytes decoded up to the
//! damage are returned (a truncated or corrupt tail, a bad block, a bad code). The quirks of the pdf.js decoder are
//! kept: bytes the bit reader pulled ahead of a stored block are lost, a stored block cut short is padded with zero
//! bytes to its declared length, and a distance reaching before the start of the output reads a zero.

use crate::CodecError;

const CODE_LEN_CODE_MAP: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/// `(extra bits << 16) | base` for the length codes 257..=287.
const LENGTH_DECODE: [u32; 31] = [
    0x00003, 0x00004, 0x00005, 0x00006, 0x00007, 0x00008, 0x00009, 0x0000a, 0x1000b, 0x1000d, 0x1000f, 0x10011, 0x20013, 0x20017, 0x2001b, 0x2001f, 0x30023,
    0x3002b, 0x30033, 0x3003b, 0x40043, 0x40053, 0x40063, 0x40073, 0x50083, 0x500a3, 0x500c3, 0x500e3, 0x00102, 0x00102, 0x00102,
];

/// `(extra bits << 16) | base` for the distance codes 0..=29.
const DIST_DECODE: [u32; 30] = [
    0x00001, 0x00002, 0x00003, 0x00004, 0x10005, 0x10007, 0x20009, 0x2000d, 0x30011, 0x30019, 0x40021, 0x40031, 0x50041, 0x50061, 0x60081, 0x600c1, 0x70101,
    0x70181, 0x80201, 0x80301, 0x90401, 0x90601, 0xa0801, 0xa0c01, 0xb1001, 0xb1801, 0xc2001, 0xc3001, 0xd4001, 0xd6001,
];

/// A Huffman lookup table: `(code length << 16) | value`, indexed by the next `max_len` bits (first bit lowest).
struct Table {
    codes: Vec<u32>,
    max_len: u32,
}

fn generate_table(lengths: &[u8]) -> Table {
    let max_len = lengths.iter().copied().max().map_or(0, u32::from);
    let size = 1usize << max_len;
    let mut codes = vec![0u32; size];
    let mut code: u32 = 0;
    let mut skip: usize = 2;
    for len in 1..=max_len {
        for (val, &l) in lengths.iter().enumerate() {
            if u32::from(l) == len {
                let mut reversed: usize = 0;
                let mut t = code;
                for _ in 0..len {
                    reversed = (reversed << 1) | (t & 1) as usize;
                    t >>= 1;
                }
                let mut i = reversed;
                while i < size {
                    codes[i] = (len << 16) | val as u32;
                    i += skip;
                }
                code += 1;
            }
        }
        code <<= 1;
        skip <<= 1;
    }
    Table { codes, max_len }
}

fn fixed_tables() -> (Table, Table) {
    let mut lit = [8u8; 288];
    lit[144..256].fill(9);
    lit[256..280].fill(7);
    (generate_table(&lit), generate_table(&[5u8; 30]))
}

/// The damage that ends a stream; never surfaced, only decides where decoding stops.
struct Damaged;

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u32,
    size: u32,
}

impl Bits<'_> {
    fn byte(&mut self) -> Option<u8> {
        let b = self.data.get(self.pos).copied();
        if b.is_some() {
            self.pos += 1;
        }
        b
    }

    fn get_bits(&mut self, bits: u32) -> Result<u32, Damaged> {
        while self.size < bits {
            let b = self.byte().ok_or(Damaged)?;
            self.buf |= u32::from(b) << self.size;
            self.size += 8;
        }
        let v = self.buf & ((1u32 << bits) - 1);
        self.buf >>= bits;
        self.size -= bits;
        Ok(v)
    }

    fn get_code(&mut self, table: &Table) -> Result<u32, Damaged> {
        while self.size < table.max_len {
            let Some(b) = self.byte() else { break };
            self.buf |= u32::from(b) << self.size;
            self.size += 8;
        }
        let code = table.codes[(self.buf & ((1u32 << table.max_len) - 1)) as usize];
        let len = code >> 16;
        if len < 1 || self.size < len {
            return Err(Damaged);
        }
        self.buf >>= len;
        self.size -= len;
        Ok(code & 0xffff)
    }
}

/// Inflates a zlib stream (RFC 1950 header, then deflate blocks). Output exceeding `limit` returns `ResourceLimit`.
pub fn inflate(input: &[u8], limit: usize) -> Result<Vec<u8>, CodecError> {
    crate::check_output(inflate_prefix(input, limit.saturating_add(1))?, limit)
}

fn inflate_prefix(input: &[u8], limit: usize) -> Result<Vec<u8>, CodecError> {
    let (Some(&cmf), Some(&flg)) = (input.first(), input.get(1)) else {
        return Err(CodecError::Format("Invalid header in flate stream".into()));
    };
    if cmf & 0x0f != 0x08 {
        return Err(CodecError::Format(format!("Unknown compression method in flate stream: {cmf}, {flg}")));
    }
    if ((u32::from(cmf) << 8) + u32::from(flg)) % 31 != 0 {
        return Err(CodecError::Format(format!("Bad FCHECK in flate stream: {cmf}, {flg}")));
    }
    if flg & 0x20 != 0 {
        return Err(CodecError::Format(format!("FDICT bit set in flate stream: {cmf}, {flg}")));
    }
    let mut bits = Bits { data: input, pos: 2, buf: 0, size: 0 };
    let mut out = Vec::new();
    let mut fixed: Option<(Table, Table)> = None;
    // A damaged block ends the stream with what was decoded so far.
    let _ = read_blocks(&mut bits, &mut out, &mut fixed, limit);
    out.truncate(limit);
    Ok(out)
}

fn read_blocks(bits: &mut Bits<'_>, out: &mut Vec<u8>, fixed: &mut Option<(Table, Table)>, limit: usize) -> Result<(), Damaged> {
    loop {
        let hdr = bits.get_bits(3)?;
        let last = hdr & 1 != 0;
        match hdr >> 1 {
            0 => {
                if stored_block(bits, out, limit)? || last {
                    return Ok(());
                }
            }
            kind @ (1 | 2) => {
                if kind == 1 {
                    let (lit, dist) = fixed.get_or_insert_with(fixed_tables);
                    huffman_block(bits, out, lit, dist, limit)?;
                } else {
                    let (lit, dist) = dynamic_tables(bits)?;
                    huffman_block(bits, out, &lit, &dist, limit)?;
                }
                if last {
                    return Ok(());
                }
            }
            _ => return Err(Damaged),
        }
        if out.len() >= limit {
            return Ok(());
        }
    }
}

/// Returns true when the stream ends with this block.
fn stored_block(bits: &mut Bits<'_>, out: &mut Vec<u8>, limit: usize) -> Result<bool, Damaged> {
    let b0 = bits.byte().ok_or(Damaged)?;
    let b1 = bits.byte().ok_or(Damaged)?;
    let c0 = bits.byte().ok_or(Damaged)?;
    let c1 = bits.byte().ok_or(Damaged)?;
    let block_len = usize::from(b0) | (usize::from(b1) << 8);
    let check = usize::from(c0) | (usize::from(c1) << 8);
    if check != (!block_len & 0xffff) && (block_len != 0 || check != 0) {
        return Err(Damaged);
    }
    bits.buf = 0;
    bits.size = 0;
    if block_len == 0 {
        return Ok(bits.pos >= bits.data.len());
    }
    let available = bits.data.len() - bits.pos;
    let take = block_len.min(available);
    out.extend_from_slice(&bits.data[bits.pos..bits.pos + take]);
    bits.pos += take;
    // pdf.js counts the whole declared length: what the input did not have reads as zero.
    let room = limit.saturating_sub(out.len());
    out.resize(out.len() + (block_len - take).min(room), 0);
    Ok(take < block_len)
}

fn dynamic_tables(bits: &mut Bits<'_>) -> Result<(Table, Table), Damaged> {
    let num_lit = bits.get_bits(5)? as usize + 257;
    let num_dist = bits.get_bits(5)? as usize + 1;
    let num_code_len = bits.get_bits(4)? as usize + 4;
    let mut code_len_lengths = [0u8; 19];
    for &slot in CODE_LEN_CODE_MAP.iter().take(num_code_len) {
        code_len_lengths[slot] = bits.get_bits(3)? as u8;
    }
    let code_len_table = generate_table(&code_len_lengths);
    let total = num_lit + num_dist;
    let mut lengths = vec![0u8; total];
    let mut len: u8 = 0;
    let mut i = 0;
    while i < total {
        let code = bits.get_code(&code_len_table)?;
        let (bits_length, bits_offset, what) = match code {
            16 => (2, 3, len),
            17 => {
                len = 0;
                (3, 3, 0)
            }
            18 => {
                len = 0;
                (7, 11, 0)
            }
            _ => {
                len = code as u8;
                lengths[i] = len;
                i += 1;
                continue;
            }
        };
        let repeat = bits.get_bits(bits_length)? as usize + bits_offset;
        for _ in 0..repeat {
            // pdf.js writes past the end of its typed array; the writes are dropped.
            if i < total {
                lengths[i] = what;
            }
            i += 1;
        }
    }
    Ok((generate_table(&lengths[..num_lit]), generate_table(&lengths[num_lit..total])))
}

fn huffman_block(bits: &mut Bits<'_>, out: &mut Vec<u8>, lit: &Table, dist: &Table, limit: usize) -> Result<(), Damaged> {
    loop {
        if out.len() >= limit {
            return Ok(());
        }
        let mut code = bits.get_code(lit)?;
        if code < 256 {
            out.push(code as u8);
            continue;
        }
        if code == 256 {
            return Ok(());
        }
        code -= 257;
        let entry = LENGTH_DECODE.get(code as usize).copied().unwrap_or(0);
        let mut extra = entry >> 16;
        if extra > 0 {
            extra = bits.get_bits(extra)?;
        }
        let len = (entry & 0xffff) + extra;
        let code = bits.get_code(dist)?;
        let entry = DIST_DECODE.get(code as usize).copied().unwrap_or(0);
        let mut extra = entry >> 16;
        if extra > 0 {
            extra = bits.get_bits(extra)?;
        }
        let distance = ((entry & 0xffff) + extra) as usize;
        for _ in 0..len {
            let byte = if distance == 0 || distance > out.len() { 0 } else { out[out.len() - distance] };
            out.push(byte);
        }
    }
}
