//! CCITT Group 3 and Group 4 fax decoding exactly as pdf.js 6.4.299 delivers it: PDFium's `fax` decoder
//! (`core/fxcodec/fax/faxmodule.cpp`) of `wasm/jbig2.wasm`, behind the wrapper that copies its scanlines into the
//! image. A damaged stream decodes as far as PDFium decodes it; rows after the end of the data are zero bytes.

use super::CodecError;

/// The `/DecodeParms` of a `CCITTFaxDecode` filter with pdf.js's defaults (`CCITTFaxStream`): `K` 0, `Columns` 1728,
/// `Rows` 0. `EndOfBlock` is not passed to the decoder and so is not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CcittParams {
    pub k: i32,
    pub end_of_line: bool,
    pub encoded_byte_align: bool,
    pub columns: i32,
    pub rows: i32,
    pub black_is_1: bool,
}

impl Default for CcittParams {
    fn default() -> Self {
        CcittParams { k: 0, end_of_line: false, encoded_byte_align: false, columns: 1728, rows: 0, black_is_1: false }
    }
}

/// The widest image or height the fax decoder accepts (`kMaxImageDimension`).
const MAX_DIMENSION: i32 = 65535;

/// Decodes `data` as the filter of an image `width` x `height` (the image dictionary's `Width` and `Height`): the
/// packed 1-bit rows, `(width + 7) / 8` bytes each, `height` rows. White is 1 unless `BlackIs1`.
pub fn decode(data: &[u8], width: i32, height: i32, params: &CcittParams) -> Result<Vec<u8>, CodecError> {
    let actual_width = if params.columns != 0 { params.columns } else { width };
    let actual_height = if params.rows != 0 { params.rows } else { height };
    if actual_width <= 0 || actual_height <= 0 || actual_width > MAX_DIMENSION || actual_height > MAX_DIMENSION {
        return Err(CodecError::Unknown);
    }
    let pitch8 = (i64::from(width) + 7) >> 3;
    let size = pitch8 * i64::from(height);
    if size < 0 {
        return Err(CodecError::Message(format!("Invalid typed array length: {size}")));
    }
    if size > i64::from(i32::MAX) {
        return Err(CodecError::Message("Array buffer allocation failed".to_owned()));
    }
    let mut out = vec![0u8; size as usize];
    if pitch8 == 0 {
        return Ok(out);
    }
    let pitch8 = pitch8 as usize;
    let mut decoder = FaxDecoder::new(data, actual_width as usize, params);
    // a negative height (with a negative pitch, so the size is not negative) decodes no row
    for row in 0..height.max(0) as usize {
        let Some(line) = decoder.next_line() else { break };
        let n = pitch8.min(line.len());
        out[row * pitch8..row * pitch8 + n].copy_from_slice(&line[..n]);
    }
    Ok(out)
}

/// `FaxG4Decode`: decodes `height` rows of `width` pixels in two-dimensional (T.6) coding from bit `start_bit` of
/// `src` into `dest` (rows `pitch` bytes apart, 1 = white, rows the data does not reach stay white) and returns the
/// bit position reached.
pub(crate) fn g4_decode(src: &[u8], start_bit: usize, width: i32, height: i32, pitch: usize, dest: &mut [u8]) -> usize {
    let mut reference = vec![0xffu8; pitch];
    let mut bit_pos = start_bit;
    let bit_size = src.len() << 3;
    for row in 0..height.max(0) as usize {
        let line = &mut dest[row * pitch..(row + 1) * pitch];
        line.fill(0xff);
        g4_row(src, bit_size, &mut bit_pos, line, &reference, width);
        reference.copy_from_slice(line);
    }
    bit_pos
}

/// The first position at or after `start` (and before `max`) holding `bit`, else `max`.
fn find_bit(buf: &[u8], max: i32, start: i32, bit: bool) -> i32 {
    if start >= max {
        return max;
    }
    let mut p = start as usize;
    let max = max as usize;
    let at = |p: usize| buf[p >> 3] & (0x80 >> (p & 7)) != 0;
    while p < max && p & 7 != 0 {
        if at(p) == bit {
            return p as i32;
        }
        p += 1;
    }
    let skip = if bit { 0x00 } else { 0xff };
    while p + 8 <= max && buf[p >> 3] == skip {
        p += 8;
    }
    while p < max {
        if at(p) == bit {
            return p as i32;
        }
        p += 1;
    }
    max as i32
}

/// `FaxG4FindB1B2`.
fn find_b1_b2(reference: &[u8], columns: i32, a0: i32, a0_color: bool) -> (i32, i32) {
    let mut first_bit = a0 < 0 || reference[(a0 / 8) as usize] & (1 << (7 - a0 % 8)) != 0;
    let mut b1 = find_bit(reference, columns, a0 + 1, !first_bit);
    if b1 >= columns {
        return (columns, columns);
    }
    if first_bit == !a0_color {
        b1 = find_bit(reference, columns, b1 + 1, first_bit);
        first_bit = !first_bit;
    }
    if b1 >= columns {
        return (columns, columns);
    }
    (b1, find_bit(reference, columns, b1 + 1, first_bit))
}

/// `FaxFillBits`: paints `[start, end)` (clamped to the row) black.
fn fill_black(dest: &mut [u8], columns: i32, start: i32, end: i32) {
    let start = start.max(0);
    let end = end.clamp(0, columns);
    for p in start..end {
        dest[(p >> 3) as usize] &= !(0x80 >> (p & 7));
    }
}

fn next_bit(src: &[u8], bit_pos: &mut usize) -> bool {
    let pos = *bit_pos;
    *bit_pos += 1;
    src.get(pos >> 3).is_some_and(|b| b & (0x80 >> (pos & 7)) != 0)
}

/// `FaxGetRun`: one run-length code of the white or black table; -1 when the data ends or no code matches.
fn get_run(runs: &[(u16, u16)], len_start: &[usize], src: &[u8], bit_pos: &mut usize, bit_size: usize) -> i32 {
    let mut code: u32 = 0;
    for len in 1..len_start.len() - 1 {
        if *bit_pos >= bit_size {
            return -1;
        }
        code = (code << 1) | u32::from(next_bit(src, bit_pos));
        for &(c, run) in &runs[len_start[len]..len_start[len + 1]] {
            if u32::from(c) == code {
                return i32::from(run);
            }
        }
    }
    -1
}

fn run_of(color_white: bool, src: &[u8], bit_pos: &mut usize, bit_size: usize) -> i32 {
    if color_white { get_run(&WHITE_RUNS, &WHITE_LEN_START, src, bit_pos, bit_size) } else { get_run(&BLACK_RUNS, &BLACK_LEN_START, src, bit_pos, bit_size) }
}

/// `FaxG4GetRow`.
fn g4_row(src: &[u8], bit_size: usize, bit_pos: &mut usize, dest: &mut [u8], reference: &[u8], columns: i32) {
    let mut a0: i32 = -1;
    let mut a0_color = true;
    loop {
        if *bit_pos >= bit_size {
            return;
        }
        let (b1, b2) = find_b1_b2(reference, columns, a0, a0_color);
        let mut v_delta = 0;
        if !next_bit(src, bit_pos) {
            if *bit_pos >= bit_size {
                return;
            }
            let bit1 = next_bit(src, bit_pos);
            if *bit_pos >= bit_size {
                return;
            }
            let bit2 = next_bit(src, bit_pos);
            if bit1 {
                v_delta = if bit2 { 1 } else { -1 };
            } else if bit2 {
                let mut run_len1 = 0i32;
                loop {
                    let run = run_of(a0_color, src, bit_pos, bit_size);
                    run_len1 = run_len1.wrapping_add(run);
                    if run_len1 > columns {
                        return;
                    }
                    if run < 64 {
                        break;
                    }
                }
                if run_len1 < 0 {
                    return;
                }
                if a0 < 0 {
                    run_len1 = run_len1.wrapping_add(1);
                }
                let a1 = a0.wrapping_add(run_len1);
                if !a0_color {
                    fill_black(dest, columns, a0, a1);
                }
                let mut run_len2 = 0i32;
                loop {
                    let run = run_of(!a0_color, src, bit_pos, bit_size);
                    run_len2 = run_len2.wrapping_add(run);
                    if run_len2 > columns {
                        return;
                    }
                    if run < 64 {
                        break;
                    }
                }
                if run_len2 < 0 {
                    return;
                }
                let a2 = a1.wrapping_add(run_len2);
                if a0_color {
                    fill_black(dest, columns, a1, a2);
                }
                a0 = a2;
                if a0 < columns {
                    continue;
                }
                return;
            } else {
                if *bit_pos >= bit_size {
                    return;
                }
                if next_bit(src, bit_pos) {
                    if !a0_color {
                        fill_black(dest, columns, a0, b2);
                    }
                    if b2 >= columns {
                        return;
                    }
                    a0 = b2;
                    continue;
                }
                if *bit_pos >= bit_size {
                    return;
                }
                let next_bit1 = next_bit(src, bit_pos);
                if *bit_pos >= bit_size {
                    return;
                }
                let next_bit2 = next_bit(src, bit_pos);
                if next_bit1 {
                    v_delta = if next_bit2 { 2 } else { -2 };
                } else if next_bit2 {
                    if *bit_pos >= bit_size {
                        return;
                    }
                    v_delta = if next_bit(src, bit_pos) { 3 } else { -3 };
                } else {
                    if *bit_pos >= bit_size {
                        return;
                    }
                    if next_bit(src, bit_pos) {
                        *bit_pos += 3;
                        continue;
                    }
                    *bit_pos += 5;
                    return;
                }
            }
        }
        let a1 = b1 + v_delta;
        if !a0_color {
            fill_black(dest, columns, a0, a1);
        }
        if a1 >= columns {
            return;
        }
        // The position of the picture element must increase.
        if a0 >= a1 {
            return;
        }
        a0 = a1;
        a0_color = !a0_color;
    }
}

/// `FaxGet1DLine`: one row of one-dimensional (T.4) run codes.
fn row_1d(src: &[u8], bit_size: usize, bit_pos: &mut usize, dest: &mut [u8], columns: i32) {
    let mut color = true;
    let mut start: i32 = 0;
    loop {
        if *bit_pos >= bit_size {
            return;
        }
        let mut run_len = 0i32;
        loop {
            let run = run_of(color, src, bit_pos, bit_size);
            if run < 0 {
                while *bit_pos < bit_size {
                    if next_bit(src, bit_pos) {
                        return;
                    }
                }
                return;
            }
            run_len = run_len.wrapping_add(run);
            if run_len > columns {
                return;
            }
            if run < 64 {
                break;
            }
        }
        if !color {
            fill_black(dest, columns, start, start.wrapping_add(run_len));
        }
        start = start.wrapping_add(run_len);
        if start >= columns {
            break;
        }
        color = !color;
    }
}

/// `FaxSkipEOL`: skips the zero bits and the 1 bit of an end-of-line code when at least 11 zeros precede the 1.
fn skip_eol(src: &[u8], bit_size: usize, bit_pos: &mut usize) {
    let start = *bit_pos;
    while *bit_pos < bit_size {
        if !next_bit(src, bit_pos) {
            continue;
        }
        if *bit_pos - start <= 11 {
            *bit_pos = start;
        }
        return;
    }
}

/// PDFium's `FaxDecoder`: the scanlines of one image.
struct FaxDecoder<'a> {
    src: &'a [u8],
    encoding: i32,
    byte_align: bool,
    end_of_line: bool,
    black: bool,
    width: i32,
    bit_pos: usize,
    scanline: Vec<u8>,
    reference: Vec<u8>,
}

impl<'a> FaxDecoder<'a> {
    fn new(src: &'a [u8], width: usize, params: &CcittParams) -> Self {
        let pitch = width.div_ceil(32) * 4;
        FaxDecoder {
            src,
            encoding: params.k,
            byte_align: params.encoded_byte_align,
            end_of_line: params.end_of_line,
            black: params.black_is_1,
            width: width as i32,
            bit_pos: 0,
            scanline: vec![0xff; pitch],
            reference: vec![0xff; pitch],
        }
    }

    /// The next scanline (`pitch` bytes), or `None` once the data is used up.
    fn next_line(&mut self) -> Option<&[u8]> {
        let bit_size = self.src.len() << 3;
        skip_eol(self.src, bit_size, &mut self.bit_pos);
        if self.bit_pos >= bit_size {
            return None;
        }
        self.scanline.fill(0xff);
        if self.encoding < 0 {
            g4_row(self.src, bit_size, &mut self.bit_pos, &mut self.scanline, &self.reference, self.width);
            self.reference.copy_from_slice(&self.scanline);
        } else if self.encoding == 0 {
            row_1d(self.src, bit_size, &mut self.bit_pos, &mut self.scanline, self.width);
        } else {
            if next_bit(self.src, &mut self.bit_pos) {
                row_1d(self.src, bit_size, &mut self.bit_pos, &mut self.scanline, self.width);
            } else {
                g4_row(self.src, bit_size, &mut self.bit_pos, &mut self.scanline, &self.reference, self.width);
            }
            self.reference.copy_from_slice(&self.scanline);
        }
        if self.end_of_line {
            skip_eol(self.src, bit_size, &mut self.bit_pos);
        }
        if self.byte_align && self.bit_pos < bit_size {
            let mut pos0 = self.bit_pos;
            let pos1 = (self.bit_pos + 7) & !7;
            while self.byte_align && pos0 < pos1 {
                if self.src[pos0 / 8] & (0x80 >> (pos0 % 8)) != 0 {
                    self.byte_align = false;
                } else {
                    pos0 += 1;
                }
            }
            if self.byte_align {
                self.bit_pos = pos1;
            }
        }
        if self.black {
            for b in &mut self.scanline {
                *b = !*b;
            }
        }
        Some(&self.scanline)
    }
}

/// white run codes, sorted by code length: (code, run).
const WHITE_RUNS: [(u16, u16); 104] = [
    (0x0007, 2),
    (0x0008, 3),
    (0x000b, 4),
    (0x000c, 5),
    (0x000e, 6),
    (0x000f, 7),
    (0x0007, 10),
    (0x0008, 11),
    (0x0012, 128),
    (0x0013, 8),
    (0x0014, 9),
    (0x001b, 64),
    (0x0003, 13),
    (0x0007, 1),
    (0x0008, 12),
    (0x0017, 192),
    (0x0018, 1664),
    (0x002a, 16),
    (0x002b, 17),
    (0x0034, 14),
    (0x0035, 15),
    (0x0003, 22),
    (0x0004, 23),
    (0x0008, 20),
    (0x000c, 19),
    (0x0013, 26),
    (0x0017, 21),
    (0x0018, 28),
    (0x0024, 27),
    (0x0027, 18),
    (0x0028, 24),
    (0x002b, 25),
    (0x0037, 256),
    (0x0002, 29),
    (0x0003, 30),
    (0x0004, 45),
    (0x0005, 46),
    (0x000a, 47),
    (0x000b, 48),
    (0x0012, 33),
    (0x0013, 34),
    (0x0014, 35),
    (0x0015, 36),
    (0x0016, 37),
    (0x0017, 38),
    (0x001a, 31),
    (0x001b, 32),
    (0x0024, 53),
    (0x0025, 54),
    (0x0028, 39),
    (0x0029, 40),
    (0x002a, 41),
    (0x002b, 42),
    (0x002c, 43),
    (0x002d, 44),
    (0x0032, 61),
    (0x0033, 62),
    (0x0034, 63),
    (0x0035, 0),
    (0x0036, 320),
    (0x0037, 384),
    (0x004a, 59),
    (0x004b, 60),
    (0x0052, 49),
    (0x0053, 50),
    (0x0054, 51),
    (0x0055, 52),
    (0x0058, 55),
    (0x0059, 56),
    (0x005a, 57),
    (0x005b, 58),
    (0x0064, 448),
    (0x0065, 512),
    (0x0067, 640),
    (0x0068, 576),
    (0x0098, 1472),
    (0x0099, 1536),
    (0x009a, 1600),
    (0x009b, 1728),
    (0x00cc, 704),
    (0x00cd, 768),
    (0x00d2, 832),
    (0x00d3, 896),
    (0x00d4, 960),
    (0x00d5, 1024),
    (0x00d6, 1088),
    (0x00d7, 1152),
    (0x00d8, 1216),
    (0x00d9, 1280),
    (0x00da, 1344),
    (0x00db, 1408),
    (0x0008, 1792),
    (0x000c, 1856),
    (0x000d, 1920),
    (0x0012, 1984),
    (0x0013, 2048),
    (0x0014, 2112),
    (0x0015, 2176),
    (0x0016, 2240),
    (0x0017, 2304),
    (0x001c, 2368),
    (0x001d, 2432),
    (0x001e, 2496),
    (0x001f, 2560),
];
/// Index into WHITE_RUNS of the first code of each length (index = length; the last entry is the table size).
const WHITE_LEN_START: [usize; 14] = [0, 0, 0, 0, 0, 6, 12, 21, 33, 75, 91, 91, 94, 104];

/// black run codes, sorted by code length: (code, run).
const BLACK_RUNS: [(u16, u16); 104] = [
    (0x0002, 3),
    (0x0003, 2),
    (0x0002, 1),
    (0x0003, 4),
    (0x0002, 6),
    (0x0003, 5),
    (0x0003, 7),
    (0x0004, 9),
    (0x0005, 8),
    (0x0004, 10),
    (0x0005, 11),
    (0x0007, 12),
    (0x0004, 13),
    (0x0007, 14),
    (0x0018, 15),
    (0x0008, 18),
    (0x000f, 64),
    (0x0017, 16),
    (0x0018, 17),
    (0x0037, 0),
    (0x0008, 1792),
    (0x000c, 1856),
    (0x000d, 1920),
    (0x0017, 24),
    (0x0018, 25),
    (0x0028, 23),
    (0x0037, 22),
    (0x0067, 19),
    (0x0068, 20),
    (0x006c, 21),
    (0x0012, 1984),
    (0x0013, 2048),
    (0x0014, 2112),
    (0x0015, 2176),
    (0x0016, 2240),
    (0x0017, 2304),
    (0x001c, 2368),
    (0x001d, 2432),
    (0x001e, 2496),
    (0x001f, 2560),
    (0x0024, 52),
    (0x0027, 55),
    (0x0028, 56),
    (0x002b, 59),
    (0x002c, 60),
    (0x0033, 320),
    (0x0034, 384),
    (0x0035, 448),
    (0x0037, 53),
    (0x0038, 54),
    (0x0052, 50),
    (0x0053, 51),
    (0x0054, 44),
    (0x0055, 45),
    (0x0056, 46),
    (0x0057, 47),
    (0x0058, 57),
    (0x0059, 58),
    (0x005a, 61),
    (0x005b, 256),
    (0x0064, 48),
    (0x0065, 49),
    (0x0066, 62),
    (0x0067, 63),
    (0x0068, 30),
    (0x0069, 31),
    (0x006a, 32),
    (0x006b, 33),
    (0x006c, 40),
    (0x006d, 41),
    (0x00c8, 128),
    (0x00c9, 192),
    (0x00ca, 26),
    (0x00cb, 27),
    (0x00cc, 28),
    (0x00cd, 29),
    (0x00d2, 34),
    (0x00d3, 35),
    (0x00d4, 36),
    (0x00d5, 37),
    (0x00d6, 38),
    (0x00d7, 39),
    (0x00da, 42),
    (0x00db, 43),
    (0x004a, 640),
    (0x004b, 704),
    (0x004c, 768),
    (0x004d, 832),
    (0x0052, 1280),
    (0x0053, 1344),
    (0x0054, 1408),
    (0x0055, 1472),
    (0x005a, 1536),
    (0x005b, 1600),
    (0x0064, 1664),
    (0x0065, 1728),
    (0x006c, 512),
    (0x006d, 576),
    (0x0072, 896),
    (0x0073, 960),
    (0x0074, 1024),
    (0x0075, 1088),
    (0x0076, 1152),
    (0x0077, 1216),
];
/// Index into BLACK_RUNS of the first code of each length (index = length; the last entry is the table size).
const BLACK_LEN_START: [usize; 15] = [0, 0, 0, 2, 4, 6, 7, 9, 12, 14, 15, 20, 30, 84, 104];

#[cfg(test)]
mod tests {
    use super::*;

    fn params(k: i32) -> CcittParams {
        CcittParams { k, columns: 8, rows: 2, ..CcittParams::default() }
    }

    #[test]
    fn two_white_rows_in_g4() {
        // V0 for each row, then EOFB
        let out = decode(&[0xc0, 0x00, 0x10, 0x01], 8, 2, &params(-1)).unwrap();
        assert_eq!(out, [0xff, 0xff]);
        let inverted = CcittParams { black_is_1: true, ..params(-1) };
        assert_eq!(decode(&[0xc0, 0x00, 0x10, 0x01], 8, 2, &inverted).unwrap(), [0x00, 0x00]);
    }

    #[test]
    fn rows_after_the_data_are_zero_bytes() {
        // the second half of the end-of-block code is read as a third row, which stays white
        let out = decode(&[0xc0, 0x00, 0x10, 0x01], 8, 4, &CcittParams { rows: 0, ..params(-1) }).unwrap();
        assert_eq!(out, [0xff, 0xff, 0xff, 0x00]);
        assert_eq!(decode(&[], 8, 2, &params(-1)).unwrap(), [0x00, 0x00]);
    }

    #[test]
    fn one_dimensional_rows() {
        // white 3 (1000), black 2 (11), white 3 (1000): 000111 | row 2: white 8 (10011)
        let data = [0b1000_1110, 0b0010_0110, 0b0000_0000];
        let out = decode(&data, 8, 2, &params(0)).unwrap();
        assert_eq!(out, [0b1110_0111, 0b1111_1111]);
    }

    #[test]
    fn the_decoder_is_refused_for_impossible_sizes() {
        assert_eq!(decode(&[0x80], 8, 2, &CcittParams { columns: -1, ..params(0) }), Err(CodecError::Unknown));
        assert_eq!(decode(&[0x80], 8, 2, &CcittParams { columns: 65536, ..params(0) }), Err(CodecError::Unknown));
        assert_eq!(decode(&[0x80], 0, 2, &CcittParams { columns: 0, ..params(0) }), Err(CodecError::Unknown));
        assert_eq!(decode(&[0x80], 8, 0, &CcittParams { rows: 0, ..params(0) }), Err(CodecError::Unknown));
        assert_eq!(decode(&[0x80], 0, 5, &params(0)).unwrap(), Vec::<u8>::new());
        // a negative width and height multiply to a positive size: no row is decoded into it
        assert_eq!(decode(&[0xc0, 0x00, 0x10, 0x01], -16, -2, &params(-1)).unwrap(), [0; 4]);
    }

    #[test]
    fn the_run_tables_are_complete_prefix_codes() {
        for (runs, starts, count) in [(&WHITE_RUNS[..], &WHITE_LEN_START[..], 104), (&BLACK_RUNS[..], &BLACK_LEN_START[..], 104)] {
            assert_eq!(runs.len(), count);
            assert_eq!(starts[starts.len() - 1], count);
            for (i, &(code, run)) in runs.iter().enumerate() {
                let len = (1..starts.len() - 1).find(|&l| i >= starts[l] && i < starts[l + 1]).unwrap();
                assert!(u32::from(code) < 1 << len, "code {code:#x} of run {run} is longer than {len} bits");
                // no code is the prefix of another
                for (j, &(other, _)) in runs.iter().enumerate() {
                    let other_len = (1..starts.len() - 1).find(|&l| j >= starts[l] && j < starts[l + 1]).unwrap();
                    if j != i && other_len >= len {
                        assert_ne!(u32::from(other) >> (other_len - len), u32::from(code));
                    }
                }
            }
        }
    }
}
