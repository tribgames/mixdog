//! A baseline JPEG encoder that writes what sharp's `jpeg()` writes: libjpeg's quality scaling of the IJG tables,
//! 4:2:0 chroma subsampling (2x2 luma sampling, a box average of the chroma with libjpeg's alternating rounding
//! bias), libjpeg's accurate integer forward DCT, baseline (sequential) coding and Huffman tables optimised for the
//! image (sharp's default `optimiseCoding`), so the encoded size, which decides the token gate, lands where
//! libjpeg-turbo's does.
//!
//! The `image` crate's `JpegEncoder` writes 4:4:4 only and with the standard tables, which is 10 to 35 percent off
//! in size, so this module is its own. The structure (blocks, zigzag, entropy symbols, marker layout) follows
//! `image` 0.25.9's `codecs/jpeg/encoder.rs` (MIT OR Apache-2.0); the transform, quantisation, colour conversion and
//! the Huffman table optimisation follow libjpeg (`jfdctint.c`, `jcdctmgr.c`, `jccolor.c`, `jcsample.c`,
//! `jchuff.c`).

/// The IJG luminance table, natural order (ITU T.81 table K.1).
const LUMA_QUANT: [u8; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, //
    12, 12, 14, 19, 26, 58, 60, 55, //
    14, 13, 16, 24, 40, 57, 69, 56, //
    14, 17, 22, 29, 51, 87, 80, 62, //
    18, 22, 37, 56, 68, 109, 103, 77, //
    24, 35, 55, 64, 81, 104, 113, 92, //
    49, 64, 78, 87, 103, 121, 120, 101, //
    72, 92, 95, 98, 112, 100, 103, 99,
];

/// The IJG chrominance table, natural order (table K.2).
const CHROMA_QUANT: [u8; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99, //
    18, 21, 26, 66, 99, 99, 99, 99, //
    24, 26, 56, 99, 99, 99, 99, 99, //
    47, 66, 99, 99, 99, 99, 99, 99, //
    99, 99, 99, 99, 99, 99, 99, 99, //
    99, 99, 99, 99, 99, 99, 99, 99, //
    99, 99, 99, 99, 99, 99, 99, 99, //
    99, 99, 99, 99, 99, 99, 99, 99,
];

/// `ZIGZAG[i]` is the natural (row-major) index of the i-th coefficient in zigzag order.
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, //
    17, 24, 32, 25, 18, 11, 4, 5, //
    12, 19, 26, 33, 40, 48, 41, 34, //
    27, 20, 13, 6, 7, 14, 21, 28, //
    35, 42, 49, 56, 57, 50, 43, 36, //
    29, 22, 15, 23, 30, 37, 44, 51, //
    58, 59, 52, 45, 38, 31, 39, 46, //
    53, 60, 61, 54, 47, 55, 62, 63,
];

/// `jpeg_quality_scaling` and `jpeg_add_quant_table` with `force_baseline`: the table for a quality, natural order.
fn quant_table(base: &[u8; 64], quality: u8) -> [i32; 64] {
    let quality = i32::from(quality.clamp(1, 100));
    let scale = if quality < 50 { 5000 / quality } else { 200 - quality * 2 };
    let mut table = [0i32; 64];
    for (slot, &value) in table.iter_mut().zip(base) {
        *slot = ((i32::from(value) * scale + 50) / 100).clamp(1, 255);
    }
    table
}

const fn fix(value: f64) -> i32 {
    (value * 65536.0 + 0.5) as i32
}

/// The planes of an image in YCbCr, padded to whole MCUs (16x16 pixels) by repeating the last column and row, as
/// libjpeg pads before it downsamples.
struct Planes {
    /// Luma, `width16` x `height16`.
    y: Vec<u8>,
    /// Chroma, `width16 / 2` x `height16 / 2`, already averaged.
    cb: Vec<u8>,
    cr: Vec<u8>,
    width16: usize,
    height16: usize,
}

fn planes(width: usize, height: usize, rgb: &[u8]) -> Planes {
    const R_Y: i32 = fix(0.29900);
    const G_Y: i32 = fix(0.58700);
    const B_Y: i32 = fix(0.11400);
    const R_CB: i32 = -fix(0.16874);
    const G_CB: i32 = -fix(0.33126);
    const B_CB: i32 = fix(0.50000);
    const R_CR: i32 = fix(0.50000);
    const G_CR: i32 = -fix(0.41869);
    const B_CR: i32 = -fix(0.08131);
    const ONE_HALF: i32 = 1 << 15;
    const CBCR_OFFSET: i32 = 128 << 16;
    let width16 = width.div_ceil(16) * 16;
    let height16 = height.div_ceil(16) * 16;
    let mut y_plane = vec![0u8; width16 * height16];
    let mut cb_full = vec![0u8; width16 * height16];
    let mut cr_full = vec![0u8; width16 * height16];
    for row in 0..height16 {
        let source_row = row.min(height - 1);
        for column in 0..width16 {
            let at = (source_row * width + column.min(width - 1)) * 3;
            let (r, g, b) = (i32::from(rgb[at]), i32::from(rgb[at + 1]), i32::from(rgb[at + 2]));
            let target = row * width16 + column;
            y_plane[target] = ((R_Y * r + G_Y * g + B_Y * b + ONE_HALF) >> 16) as u8;
            cb_full[target] = ((R_CB * r + G_CB * g + B_CB * b + CBCR_OFFSET + ONE_HALF - 1) >> 16) as u8;
            cr_full[target] = ((R_CR * r + G_CR * g + B_CR * b + CBCR_OFFSET + ONE_HALF - 1) >> 16) as u8;
        }
    }
    let (chroma_w, chroma_h) = (width16 / 2, height16 / 2);
    let downsample = |full: &[u8]| {
        let mut out = vec![0u8; chroma_w * chroma_h];
        for cy in 0..chroma_h {
            let mut bias = 1u32;
            for cx in 0..chroma_w {
                let top = 2 * cy * width16 + 2 * cx;
                let sum = u32::from(full[top]) + u32::from(full[top + 1]) + u32::from(full[top + width16]) + u32::from(full[top + width16 + 1]);
                out[cy * chroma_w + cx] = ((sum + bias) >> 2) as u8;
                bias ^= 3;
            }
        }
        out
    };
    Planes { cb: downsample(&cb_full), cr: downsample(&cr_full), y: y_plane, width16, height16 }
}

const CONST_BITS: i32 = 13;
const PASS1_BITS: i32 = 2;
const FIX_0_298631336: i32 = 2446;
const FIX_0_390180644: i32 = 3196;
const FIX_0_541196100: i32 = 4433;
const FIX_0_765366865: i32 = 6270;
const FIX_0_899976223: i32 = 7373;
const FIX_1_175875602: i32 = 9633;
const FIX_1_501321110: i32 = 12299;
const FIX_1_847759065: i32 = 15137;
const FIX_1_961570560: i32 = 16069;
const FIX_2_053119869: i32 = 16819;
const FIX_2_562915447: i32 = 20995;
const FIX_3_072711026: i32 = 25172;

fn descale(value: i32, bits: i32) -> i32 {
    (value + (1 << (bits - 1))) >> bits
}

/// One 8-point pass of libjpeg's `jpeg_fdct_islow`, over `data[start + k * step]`. The first pass (rows) keeps
/// PASS1_BITS of extra precision and the second (columns) removes them.
fn fdct_pass(data: &mut [i32; 64], start: usize, step: usize, first_pass: bool) {
    let at = |k: usize| start + k * step;
    let d: [i32; 8] = std::array::from_fn(|k| data[at(k)]);
    let tmp0 = d[0] + d[7];
    let tmp7 = d[0] - d[7];
    let tmp1 = d[1] + d[6];
    let tmp6 = d[1] - d[6];
    let tmp2 = d[2] + d[5];
    let tmp5 = d[2] - d[5];
    let tmp3 = d[3] + d[4];
    let tmp4 = d[3] - d[4];
    let tmp10 = tmp0 + tmp3;
    let tmp13 = tmp0 - tmp3;
    let tmp11 = tmp1 + tmp2;
    let tmp12 = tmp1 - tmp2;
    let (even_shift, odd_shift) =
        if first_pass { (CONST_BITS - PASS1_BITS, CONST_BITS - PASS1_BITS) } else { (CONST_BITS + PASS1_BITS, CONST_BITS + PASS1_BITS) };
    if first_pass {
        data[at(0)] = (tmp10 + tmp11) << PASS1_BITS;
        data[at(4)] = (tmp10 - tmp11) << PASS1_BITS;
    } else {
        data[at(0)] = descale(tmp10 + tmp11, PASS1_BITS);
        data[at(4)] = descale(tmp10 - tmp11, PASS1_BITS);
    }
    let z1 = (tmp12 + tmp13) * FIX_0_541196100;
    data[at(2)] = descale(z1 + tmp13 * FIX_0_765366865, even_shift);
    data[at(6)] = descale(z1 - tmp12 * FIX_1_847759065, even_shift);
    let z1 = tmp4 + tmp7;
    let z2 = tmp5 + tmp6;
    let z3 = tmp4 + tmp6;
    let z4 = tmp5 + tmp7;
    let z5 = (z3 + z4) * FIX_1_175875602;
    let tmp4 = tmp4 * FIX_0_298631336;
    let tmp5 = tmp5 * FIX_2_053119869;
    let tmp6 = tmp6 * FIX_3_072711026;
    let tmp7 = tmp7 * FIX_1_501321110;
    let z1 = -z1 * FIX_0_899976223;
    let z2 = -z2 * FIX_2_562915447;
    let z3 = -z3 * FIX_1_961570560 + z5;
    let z4 = -z4 * FIX_0_390180644 + z5;
    data[at(7)] = descale(tmp4 + z1 + z3, odd_shift);
    data[at(5)] = descale(tmp5 + z2 + z4, odd_shift);
    data[at(3)] = descale(tmp6 + z2 + z3, odd_shift);
    data[at(1)] = descale(tmp7 + z1 + z4, odd_shift);
}

/// The quantised coefficients of the 8x8 block of `plane` at block (`bx`, `by`), in zigzag order.
fn block(plane: &[u8], stride: usize, bx: usize, by: usize, quant: &[i32; 64]) -> [i16; 64] {
    let mut data = [0i32; 64];
    for row in 0..8 {
        let at = (by * 8 + row) * stride + bx * 8;
        for column in 0..8 {
            data[row * 8 + column] = i32::from(plane[at + column]) - 128;
        }
    }
    for row in 0..8 {
        fdct_pass(&mut data, row * 8, 1, true);
    }
    for column in 0..8 {
        fdct_pass(&mut data, column, 8, false);
    }
    let mut out = [0i16; 64];
    for (slot, &natural) in out.iter_mut().zip(&ZIGZAG) {
        let divisor = quant[natural] << 3;
        let value = data[natural];
        let quantised = if value < 0 { -((-value + (divisor >> 1)) / divisor) } else { (value + (divisor >> 1)) / divisor };
        *slot = quantised as i16;
    }
    out
}

/// The tables of the entropy coder: 0 and 1 are the DC tables of luma and chroma, 2 and 3 their AC tables.
const DC_LUMA: u8 = 0;
const DC_CHROMA: u8 = 1;
const AC_LUMA: u8 = 2;
const AC_CHROMA: u8 = 3;

/// One Huffman symbol with the extra bits that follow it.
#[derive(Clone, Copy)]
struct Symbol {
    table: u8,
    symbol: u8,
    extra_len: u8,
    extra: u16,
}

fn magnitude(value: i32) -> (u8, u16) {
    let abs = value.unsigned_abs();
    let len = (32 - abs.leading_zeros()) as u8;
    let bits = if value < 0 { (value - 1) as u32 & ((1u32 << len) - 1) } else { value as u32 };
    (len, bits as u16)
}

/// The symbols of one block: its DC difference, then run-length coded AC coefficients.
fn symbols(block: &[i16; 64], previous_dc: &mut i32, dc_table: u8, ac_table: u8, out: &mut Vec<Symbol>) {
    let dc = i32::from(block[0]);
    let (len, bits) = magnitude(dc - *previous_dc);
    *previous_dc = dc;
    out.push(Symbol { table: dc_table, symbol: len, extra_len: len, extra: bits });
    let mut run = 0u8;
    for &coefficient in &block[1..] {
        if coefficient == 0 {
            run += 1;
            continue;
        }
        while run > 15 {
            out.push(Symbol { table: ac_table, symbol: 0xF0, extra_len: 0, extra: 0 });
            run -= 16;
        }
        let (len, bits) = magnitude(i32::from(coefficient));
        out.push(Symbol { table: ac_table, symbol: (run << 4) | len, extra_len: len, extra: bits });
        run = 0;
    }
    if run > 0 {
        out.push(Symbol { table: ac_table, symbol: 0x00, extra_len: 0, extra: 0 });
    }
}

/// A Huffman table as it is written: the number of codes of each length 1 to 16, and the symbols in code order.
struct HuffmanTable {
    counts: [u8; 17],
    values: Vec<u8>,
}

/// `jpeg_gen_optimal_table` (ITU T.81 K.2): code lengths from the symbol frequencies, limited to 16 bits, with one
/// code point reserved so no symbol is all ones.
fn optimal_table(frequencies: &[u32; 257]) -> HuffmanTable {
    let mut freq = [0i64; 257];
    for (slot, &count) in freq.iter_mut().zip(frequencies.iter()) {
        *slot = i64::from(count);
    }
    freq[256] = 1;
    let mut code_size = [0usize; 257];
    let mut others = [-1i32; 257];
    loop {
        let mut c1 = -1i32;
        let mut least = i64::MAX;
        for (index, &count) in freq.iter().enumerate() {
            if count != 0 && count <= least {
                least = count;
                c1 = index as i32;
            }
        }
        let mut c2 = -1i32;
        least = i64::MAX;
        for (index, &count) in freq.iter().enumerate() {
            if count != 0 && count <= least && index as i32 != c1 {
                least = count;
                c2 = index as i32;
            }
        }
        if c2 < 0 {
            break;
        }
        freq[c1 as usize] += freq[c2 as usize];
        freq[c2 as usize] = 0;
        code_size[c1 as usize] += 1;
        while others[c1 as usize] >= 0 {
            c1 = others[c1 as usize];
            code_size[c1 as usize] += 1;
        }
        others[c1 as usize] = c2;
        code_size[c2 as usize] += 1;
        while others[c2 as usize] >= 0 {
            c2 = others[c2 as usize];
            code_size[c2 as usize] += 1;
        }
    }
    let mut bits = [0i32; 33];
    for &size in &code_size {
        if size > 0 {
            bits[size.min(32)] += 1;
        }
    }
    for i in (17..=32).rev() {
        while bits[i] > 0 {
            let mut j = i - 2;
            while bits[j] == 0 {
                j -= 1;
            }
            bits[i] -= 2;
            bits[i - 1] += 1;
            bits[j + 1] += 2;
            bits[j] -= 1;
        }
    }
    let mut longest = 16;
    while bits[longest] == 0 {
        longest -= 1;
    }
    bits[longest] -= 1;
    let mut counts = [0u8; 17];
    for (slot, &count) in counts.iter_mut().zip(bits.iter()).skip(1) {
        *slot = count as u8;
    }
    let mut values = Vec::new();
    for length in 1..=32 {
        for (symbol, &size) in code_size.iter().enumerate().take(256) {
            if size == length {
                values.push(symbol as u8);
            }
        }
    }
    HuffmanTable { counts, values }
}

/// The code (value, length) of every symbol of a table.
fn codes(table: &HuffmanTable) -> [(u32, u8); 256] {
    let mut out = [(0u32, 0u8); 256];
    let mut code = 0u32;
    let mut next = 0;
    for length in 1..=16u8 {
        for _ in 0..table.counts[usize::from(length)] {
            out[usize::from(table.values[next])] = (code, length);
            code += 1;
            next += 1;
        }
        code <<= 1;
    }
    out
}

struct BitWriter {
    out: Vec<u8>,
    accumulator: u64,
    count: u8,
}

impl BitWriter {
    fn put(&mut self, bits: u32, length: u8) {
        if length == 0 {
            return;
        }
        self.accumulator = (self.accumulator << length) | u64::from(bits);
        self.count += length;
        while self.count >= 8 {
            let byte = ((self.accumulator >> (self.count - 8)) & 0xFF) as u8;
            self.out.push(byte);
            if byte == 0xFF {
                self.out.push(0);
            }
            self.count -= 8;
        }
        self.accumulator &= (1u64 << self.count) - 1;
    }

    /// Pads the last byte with ones, as the standard asks.
    fn finish(mut self) -> Vec<u8> {
        if self.count > 0 {
            let pad = 8 - self.count;
            self.put((1u32 << pad) - 1, pad);
        }
        self.out
    }
}

fn marker(out: &mut Vec<u8>, code: u8, payload: &[u8]) {
    out.extend_from_slice(&[0xFF, code]);
    out.extend_from_slice(&(payload.len() as u16 + 2).to_be_bytes());
    out.extend_from_slice(payload);
}

/// SOI through SOS: JFIF, both quantisation tables, the 4:2:0 frame header, the four Huffman tables and the scan header.
fn write_headers(out: &mut Vec<u8>, (w, h): (usize, usize), [luma_quant, chroma_quant]: [&[i32; 64]; 2], tables: &[HuffmanTable]) {
    out.extend_from_slice(&[0xFF, 0xD8]);
    // JFIF 1.01, no density unit, 1:1 aspect, no thumbnail.
    marker(out, 0xE0, &[b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    for (id, quant) in [(0u8, luma_quant), (1u8, chroma_quant)] {
        let mut payload = vec![id];
        payload.extend(ZIGZAG.iter().map(|&natural| quant[natural] as u8));
        marker(out, 0xDB, &payload);
    }
    let mut frame = vec![8];
    frame.extend_from_slice(&(h as u16).to_be_bytes());
    frame.extend_from_slice(&(w as u16).to_be_bytes());
    frame.push(3);
    frame.extend_from_slice(&[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    marker(out, 0xC0, &frame);
    // Class and id of each table in the order libjpeg writes them: DC 0, AC 0, DC 1, AC 1.
    for (slot, class_and_id) in [(DC_LUMA, 0x00u8), (AC_LUMA, 0x10), (DC_CHROMA, 0x01), (AC_CHROMA, 0x11)] {
        let table = &tables[usize::from(slot)];
        let mut payload = vec![class_and_id];
        payload.extend_from_slice(&table.counts[1..]);
        payload.extend_from_slice(&table.values);
        marker(out, 0xC4, &payload);
    }
    marker(out, 0xDA, &[3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
}

/// Encodes 8-bit RGB (`rgb`, 3 bytes a pixel, `width` x `height`, both at least 1 and at most 65535) as a baseline
/// 4:2:0 JPEG at `quality` (1 to 100).
pub fn encode_rgb(width: u32, height: u32, rgb: &[u8], quality: u8) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    assert!((1..=65535).contains(&w) && (1..=65535).contains(&h) && rgb.len() == w * h * 3, "encode_rgb: a bad image size");
    let luma_quant = quant_table(&LUMA_QUANT, quality);
    let chroma_quant = quant_table(&CHROMA_QUANT, quality);
    let planes = planes(w, h, rgb);
    let (mcus_x, mcus_y) = (planes.width16 / 16, planes.height16 / 16);
    let chroma_stride = planes.width16 / 2;
    debug_assert_eq!(planes.height16 / 2 * chroma_stride, planes.cb.len());

    // Pass one: every block's coefficients become symbols, which also count the frequencies.
    let mut events: Vec<Symbol> = Vec::with_capacity(mcus_x * mcus_y * 80);
    let mut last_dc = [0i32; 3];
    for my in 0..mcus_y {
        for mx in 0..mcus_x {
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let coefficients = block(&planes.y, planes.width16, mx * 2 + dx, my * 2 + dy, &luma_quant);
                symbols(&coefficients, &mut last_dc[0], DC_LUMA, AC_LUMA, &mut events);
            }
            let cb = block(&planes.cb, chroma_stride, mx, my, &chroma_quant);
            symbols(&cb, &mut last_dc[1], DC_CHROMA, AC_CHROMA, &mut events);
            let cr = block(&planes.cr, chroma_stride, mx, my, &chroma_quant);
            symbols(&cr, &mut last_dc[2], DC_CHROMA, AC_CHROMA, &mut events);
        }
    }
    let mut frequencies = [[0u32; 257]; 4];
    for event in &events {
        frequencies[usize::from(event.table)][usize::from(event.symbol)] += 1;
    }
    let tables: Vec<HuffmanTable> = frequencies.iter().map(optimal_table).collect();
    let table_codes: Vec<[(u32, u8); 256]> = tables.iter().map(codes).collect();

    let mut out = Vec::with_capacity(events.len() / 2 + 1024);
    write_headers(&mut out, (w, h), [&luma_quant, &chroma_quant], &tables);

    let mut writer = BitWriter { out, accumulator: 0, count: 0 };
    for event in &events {
        let (code, length) = table_codes[usize::from(event.table)][usize::from(event.symbol)];
        writer.put(code, length);
        writer.put(u32::from(event.extra), event.extra_len);
    }
    let mut out = writer.finish();
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quant_tables_scale_like_libjpeg() {
        let q50 = quant_table(&LUMA_QUANT, 50);
        assert_eq!(q50, LUMA_QUANT.map(i32::from));
        let q90 = quant_table(&LUMA_QUANT, 90);
        assert_eq!(&q90[..4], &[3, 2, 2, 3]);
        let q10 = quant_table(&CHROMA_QUANT, 10);
        assert_eq!(q10[0], 85);
        assert!(q10.iter().all(|&v| (1..=255).contains(&v)));
        assert!(quant_table(&LUMA_QUANT, 100).iter().all(|&v| v == 1));
    }

    #[test]
    fn a_flat_block_has_only_a_dc_coefficient() {
        let plane = vec![200u8; 64];
        let coefficients = block(&plane, 8, 0, 0, &quant_table(&LUMA_QUANT, 50));
        // (200 - 128) * 8 / 16 = 36
        assert_eq!(coefficients[0], 36);
        assert!(coefficients[1..].iter().all(|&c| c == 0));
    }

    #[test]
    fn magnitudes_carry_a_ones_complement_extra() {
        assert_eq!(magnitude(0), (0, 0));
        assert_eq!(magnitude(1), (1, 1));
        assert_eq!(magnitude(-1), (1, 0));
        assert_eq!(magnitude(5), (3, 5));
        assert_eq!(magnitude(-5), (3, 2));
        assert_eq!(magnitude(-255), (8, 0));
    }

    #[test]
    fn the_optimal_table_gives_frequent_symbols_shorter_codes_within_sixteen_bits() {
        let mut frequencies = [0u32; 257];
        frequencies[0] = 1000;
        frequencies[1] = 100;
        frequencies[2] = 10;
        frequencies[3] = 1;
        let table = optimal_table(&frequencies);
        assert_eq!(table.values.len(), 4);
        assert_eq!(table.values[0], 0);
        let total: u32 = table.counts.iter().map(|&c| u32::from(c)).sum();
        assert_eq!(total, 4);
        let codes = codes(&table);
        assert!(codes[0].1 < codes[3].1);
        assert!(codes.iter().all(|&(_, length)| length <= 16));
        // A table of one symbol still gets a one-bit code.
        let mut single = [0u32; 257];
        single[7] = 5;
        let table = optimal_table(&single);
        assert_eq!(table.values, [7]);
        assert_eq!(table.counts[1], 1);
    }

    #[test]
    fn a_skewed_alphabet_is_cut_to_sixteen_bit_codes() {
        let mut frequencies = [0u32; 257];
        let mut weight = 1u32;
        for slot in frequencies.iter_mut().take(24) {
            *slot = weight;
            weight = weight.saturating_mul(2).min(1 << 30);
        }
        let table = optimal_table(&frequencies);
        assert!(codes(&table).iter().all(|&(_, length)| length <= 16));
        assert_eq!(table.values.len(), 24);
    }

    #[test]
    fn the_stream_is_a_framed_baseline_jpeg() {
        let (w, h) = (19u32, 7u32);
        let rgb: Vec<u8> = (0..w * h * 3).map(|i| (i * 7 % 251) as u8).collect();
        let jpeg = encode_rgb(w, h, &rgb, 80);
        assert_eq!(&jpeg[..4], &[0xFF, 0xD8, 0xFF, 0xE0]);
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xFF, 0xD9]);
        // SOF0 carries the size and 2x2 luma sampling.
        let sof = jpeg.windows(2).position(|pair| pair == [0xFF, 0xC0]).expect("a SOF0 marker");
        assert_eq!(u16::from_be_bytes([jpeg[sof + 5], jpeg[sof + 6]]), h as u16);
        assert_eq!(u16::from_be_bytes([jpeg[sof + 7], jpeg[sof + 8]]), w as u16);
        assert_eq!(jpeg[sof + 9], 3);
        assert_eq!(jpeg[sof + 11], 0x22);
        // Inside the entropy data every 0xFF is stuffed with a zero.
        let scan = jpeg.windows(2).position(|pair| pair == [0xFF, 0xDA]).expect("a SOS marker") + 14;
        let data = &jpeg[scan..jpeg.len() - 2];
        assert!(data.windows(2).all(|pair| pair[0] != 0xFF || pair[1] == 0), "an unstuffed 0xFF in the scan");
    }

    #[test]
    fn a_lower_quality_is_a_smaller_file() {
        let (w, h) = (64u32, 48u32);
        let mut rgb = Vec::new();
        let mut state = 12345u32;
        for y in 0..h {
            for x in 0..w {
                state = state.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let noise = (state >> 16 & 31) as i32;
                rgb.extend_from_slice(&[(x as i32 * 4 + noise).clamp(0, 255) as u8, (y as i32 * 5 + noise).clamp(0, 255) as u8, 128]);
            }
        }
        let high = encode_rgb(w, h, &rgb, 90).len();
        let low = encode_rgb(w, h, &rgb, 20).len();
        assert!(low < high, "{low} vs {high}");
    }
}
