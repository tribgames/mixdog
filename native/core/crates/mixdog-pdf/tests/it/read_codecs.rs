//! The bi-level image codecs behind the reader, on inputs written here: CCITT Group 3 and Group 4 rows coded by hand
//! from the code tables of ITU-T T.4 and T.6, and JBIG2 generic regions coded with an MQ encoder of the standard (every
//! template) or as MMR, wrapped in segments of T.88 and placed on a page.

use mixdog_pdf::codec::ccitt::{self, CcittParams};
use mixdog_pdf::codec::jbig2;

use crate::read_support::{MqEncoder, pack_bits};

pub(crate) fn params(k: i32, columns: i32) -> CcittParams {
    CcittParams { k, columns, ..CcittParams::default() }
}

#[test]
pub(crate) fn group_3_one_dimensional_rows_are_runs_of_white_and_black() {
    // Terminating codes: white 4 = 1011, black 5 = 0011, white 7 = 1111, white 16 = 101010.
    let data = pack_bits("1011 0011 1111  101010");
    let rows = ccitt::decode(&data, 16, 2, &params(0, 16)).expect("decodes");
    // 1 is white: row 1 is 4 white, 5 black, 7 white; row 2 is all white.
    assert_eq!(rows, [0b1111_0000, 0b0111_1111, 0xFF, 0xFF]);
    let inverted = CcittParams { black_is_1: true, ..params(0, 16) };
    assert_eq!(ccitt::decode(&data, 16, 2, &inverted).expect("decodes"), [0b0000_1111, 0b1000_0000, 0, 0]);
}

#[test]
pub(crate) fn a_run_longer_than_63_is_a_make_up_code_and_a_terminating_code() {
    // White 70 = make-up 64 (11011) + white 6 (1110); black 10 = 0000100. 80 columns.
    let data = pack_bits("11011 1110 0000100");
    let row = ccitt::decode(&data, 80, 1, &params(0, 80)).expect("decodes");
    let mut expected = vec![0xFF; 8];
    expected.extend([0b1111_1100, 0x00]);
    assert_eq!(row, expected);
}

#[test]
pub(crate) fn group_3_rows_may_start_with_an_end_of_line_code() {
    let eol = "000000000001";
    let data = pack_bits(&format!("{eol} 1011 0011 1111  {eol} 101010"));
    let rows = ccitt::decode(&data, 16, 2, &CcittParams { end_of_line: true, ..params(0, 16) }).expect("decodes");
    assert_eq!(rows, [0b1111_0000, 0b0111_1111, 0xFF, 0xFF]);
}

#[test]
pub(crate) fn group_4_codes_each_row_against_the_row_above_it() {
    // Width 8. Row 1 (reference all white): 3 white, 2 black, 3 white = horizontal 001 + white 3 (1000) + black 2 (11),
    // then vertical-0 (1) for the end. Row 2 equals row 1: three vertical-0 codes. Row 3 has its black run one
    // pixel to the left: vertical-left-1 (010) then two vertical-0 codes.
    let data = pack_bits("001 1000 11 1   1 1 1   010 1 1");
    let rows = ccitt::decode(&data, 8, 3, &params(-1, 8)).expect("decodes");
    assert_eq!(rows, [0b1110_0111, 0b1110_0111, 0b1100_0111]);
}

#[test]
pub(crate) fn group_4_pass_mode_skips_a_run_the_row_above_has_and_this_row_has_not() {
    // Row 1: 2 white, 2 black, 4 white (horizontal 001, white 2 = 0111, black 2 = 11, vertical-0). Row 2 is all
    // white: the black run of the row above ends before this row's next change, so pass mode (0001), then vertical-0.
    let data = pack_bits("001 0111 11 1   0001 1");
    let rows = ccitt::decode(&data, 8, 2, &params(-1, 8)).expect("decodes");
    assert_eq!(rows, [0b1100_1111, 0xFF]);
}

// ---- JBIG2 ----------------------------------------------------------------------------------------------------------

pub(crate) fn be32(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

pub(crate) fn segment(number: u32, kind: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(be32(number));
    out.push(kind);
    out.push(0); // no referred-to segments
    out.push(1); // page 1
    out.extend(be32(data.len() as u32));
    out.extend_from_slice(data);
    out
}

pub(crate) fn page_information(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend(be32(width));
    data.extend(be32(height));
    data.extend([0; 8]); // resolutions
    data.push(0); // default pixel white
    data.extend([0, 0]); // no stripes
    segment(0, 48, &data)
}

/// An immediate generic region segment (type 38) of `width` x `height` at (`x`, `y`), combined with OR.
pub(crate) fn generic_region(width: u32, height: u32, x: u32, y: u32, flags: u8, at: &[u8], coded: &[u8]) -> Vec<u8> {
    let mut data = Vec::new();
    for value in [width, height, x, y] {
        data.extend(be32(value));
    }
    data.push(0);
    data.push(flags);
    data.extend_from_slice(at);
    data.extend_from_slice(coded);
    segment(1, 38, &data)
}

/// The PDF form of a decoded page: rows of packed bits, 0 for black; the unused bits at the end of a row are white.
pub(crate) fn packed(black: &[Vec<u8>]) -> Vec<u8> {
    black.iter().flat_map(|row| row.chunks(8).map(|bits| (0..8).fold(0u8, |acc, i| (acc << 1) | bits.get(i).map_or(1, |&b| 1 - b)))).collect()
}

pub(crate) fn bitmap() -> Vec<Vec<u8>> {
    ["0000000000000000", "0111100000011000", "0100100000011000", "0111100110000001", "0000000110000011", "1010101010101010"]
        .iter()
        .map(|row| row.bytes().map(|b| b - b'0').collect())
        .collect()
}

/// The pixels a template looks at (as offsets from the pixel being coded) with the default adaptive pixels, and the
/// bytes of the adaptive-pixel pairs that go into the segment.
pub(crate) fn template(number: u8) -> (Vec<(i32, i32)>, Vec<u8>) {
    match number {
        0 => (
            vec![
                (-1, -2),
                (0, -2),
                (1, -2),
                (-2, -2),
                (2, -2),
                (-2, -1),
                (-1, -1),
                (0, -1),
                (1, -1),
                (2, -1),
                (-3, -1),
                (3, -1),
                (-1, 0),
                (-2, 0),
                (-3, 0),
                (-4, 0),
            ],
            vec![3, 0xFF, 0xFD, 0xFF, 2, 0xFE, 0xFE, 0xFE],
        ),
        1 => (vec![(-1, -2), (0, -2), (1, -2), (2, -2), (-2, -1), (-1, -1), (0, -1), (1, -1), (2, -1), (3, -1), (-1, 0), (-2, 0), (-3, 0)], vec![3, 0xFF]),
        2 => (vec![(-1, -2), (0, -2), (1, -2), (-2, -1), (-1, -1), (0, -1), (1, -1), (2, -1), (-1, 0), (-2, 0)], vec![2, 0xFF]),
        _ => (vec![(-3, -1), (-2, -1), (-1, -1), (0, -1), (1, -1), (2, -1), (-4, 0), (-3, 0), (-2, 0), (-1, 0)], vec![2, 0xFF]),
    }
}

/// The arithmetic coding of a generic region without typical prediction: each pixel is coded in the context of the
/// pixels of its template (outside the bitmap they are white).
pub(crate) fn encode_generic(black: &[Vec<u8>], offsets: &[(i32, i32)]) -> Vec<u8> {
    let pixel = |x: i32, y: i32| -> usize {
        if x < 0 || y < 0 || y as usize >= black.len() || x as usize >= black[0].len() { 0 } else { usize::from(black[y as usize][x as usize]) }
    };
    let mut coder = MqEncoder::new(1 << offsets.len(), &[]);
    for y in 0..black.len() as i32 {
        for x in 0..black[0].len() as i32 {
            let context = offsets.iter().enumerate().fold(0, |acc, (k, (dx, dy))| acc | (pixel(x + dx, y + dy) << k));
            coder.encode(context, black[y as usize][x as usize]);
        }
    }
    coder.finish(true)
}

#[test]
pub(crate) fn an_arithmetic_coded_generic_region_decodes_to_its_bitmap_with_every_template() {
    let black = bitmap();
    for number in 0..4u8 {
        let (offsets, at) = template(number);
        let mut stream = page_information(16, 6);
        stream.extend(generic_region(16, 6, 0, 0, number << 1, &at, &encode_generic(&black, &offsets)));
        let decoded = jbig2::decode(&stream, 16, 6, None).unwrap_or_else(|e| panic!("template {number}: {e}"));
        assert_eq!(decoded, packed(&black), "template {number}");
    }
}

#[test]
pub(crate) fn an_mmr_generic_region_is_placed_on_the_page_at_its_offset() {
    // The three rows of the Group 4 example (3 white, 2 black, 3 white; the same; 2 white, 3 black, 3 white) as an
    // 8 x 3 region at (4, 1) of a 16 x 5 page. JBIG2 flags: bit 0 set for MMR.
    let coded = pack_bits("001 1000 11 1   1 1 1   010 1 1");
    let mut stream = page_information(16, 5);
    stream.extend(generic_region(8, 3, 4, 1, 1, &[], &coded));
    let decoded = jbig2::decode(&stream, 16, 5, None).expect("decodes");
    let mut black = vec![vec![0u8; 16]; 5];
    for (row, pixels) in ["00011000", "00011000", "00111000"].iter().enumerate() {
        for (column, pixel) in pixels.bytes().enumerate() {
            black[row + 1][column + 4] = pixel - b'0';
        }
    }
    assert_eq!(decoded, packed(&black));
}

#[test]
pub(crate) fn a_region_before_any_page_information_fails_the_stream() {
    let (offsets, at) = template(0);
    let stream = generic_region(16, 6, 0, 0, 0, &at, &encode_generic(&bitmap(), &offsets));
    assert!(jbig2::decode(&stream, 16, 6, None).is_err());
}

// ---- JBIG2: typical prediction, refinement, symbols and text, halftones, Huffman coding -----------------------------

pub(crate) fn segment_with(number: u32, kind: u8, referred: &[u32], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(be32(number));
    out.push(kind);
    out.push((referred.len() as u8) << 5);
    out.extend(referred.iter().map(|&n| n as u8));
    out.push(1);
    out.extend(be32(data.len() as u32));
    out.extend_from_slice(data);
    out
}

pub(crate) fn region_info(width: usize, height: usize, x: usize, y: usize, operator: u8) -> Vec<u8> {
    let mut out = Vec::new();
    for value in [width, height, x, y] {
        out.extend(be32(value as u32));
    }
    out.push(operator);
    out
}

pub(crate) fn pixel(black: &[Vec<u8>], x: i32, y: i32) -> usize {
    if x < 0 || y < 0 || y as usize >= black.len() || x as usize >= black[0].len() { 0 } else { usize::from(black[y as usize][x as usize]) }
}

pub(crate) fn rows(text: &[&str]) -> Vec<Vec<u8>> {
    text.iter().map(|row| row.bytes().map(|b| b - b'0').collect()).collect()
}

/// `symbol` drawn onto `canvas` with its top left corner at (`x`, `y`), combined with OR.
pub(crate) fn place(canvas: &mut [Vec<u8>], symbol: &[Vec<u8>], x: usize, y: usize) {
    for (row, pixels) in symbol.iter().enumerate() {
        for (column, &value) in pixels.iter().enumerate() {
            canvas[y + row][x + column] |= value;
        }
    }
}

/// Typical prediction (6.2.5.7): a bit before each row says whether it repeats the row above. Its context is a fixed
/// pattern of the template; the contexts here are numbered with the template's pixels in reading order, the first the
/// most significant bit, which is the numbering those fixed values are given in.
#[test]
pub(crate) fn typical_prediction_repeats_rows_for_every_template() {
    let black = rows(&[
        "0000000000000000",
        "0111100000011000",
        "0111100000011000",
        "0111100000011000",
        "0000000110000001",
        "0000000110000001",
        "0000000000000000",
        "1010101010101010",
    ]);
    for (number, sltp) in [(0u8, 0x9B25usize), (1, 0x0795), (2, 0x00E5), (3, 0x0195)] {
        let (mut offsets, at) = template(number);
        offsets.sort_by_key(|&(dx, dy)| (dy, dx));
        let mut coder = MqEncoder::new(1 << offsets.len(), &[]);
        let mut repeated = 0u8;
        for y in 0..black.len() {
            let same = if y == 0 { black[0].iter().all(|&p| p == 0) } else { black[y] == black[y - 1] };
            coder.encode(sltp, u8::from(same) ^ repeated);
            repeated = u8::from(same);
            if same {
                continue;
            }
            for x in 0..black[0].len() {
                let context = offsets.iter().fold(0, |acc, &(dx, dy)| (acc << 1) | pixel(&black, x as i32 + dx, y as i32 + dy));
                coder.encode(context, black[y][x]);
            }
        }
        let mut stream = page_information(16, 8);
        stream.extend(generic_region(16, 8, 0, 0, (number << 1) | 8, &at, &coder.finish(true)));
        let decoded = jbig2::decode(&stream, 16, 8, None).unwrap_or_else(|e| panic!("template {number}: {e}"));
        assert_eq!(decoded, packed(&black), "template {number}");
    }
}

/// The refinement of a bitmap against a reference (6.3): each pixel is coded in the context of the pixels already
/// coded around it in the new bitmap and of the 3 x 3 pixels around its place in the reference bitmap.
pub(crate) fn encode_refinement(target: &[Vec<u8>], reference: &[Vec<u8>], coding: &[(i32, i32)], refer: &[(i32, i32)]) -> Vec<u8> {
    let mut coder = MqEncoder::new(1 << (coding.len() + refer.len()), &[]);
    for y in 0..target.len() as i32 {
        for x in 0..target[0].len() as i32 {
            let mut context = coding.iter().fold(0, |acc, &(dx, dy)| (acc << 1) | pixel(target, x + dx, y + dy));
            context = refer.iter().fold(context, |acc, &(dx, dy)| (acc << 1) | pixel(reference, x + dx, y + dy));
            coder.encode(context, target[y as usize][x as usize]);
        }
    }
    coder.finish(true)
}

#[test]
pub(crate) fn a_refinement_region_replaces_the_page_it_refines_with_the_corrected_bitmap() {
    let before = rows(&["0000000000000000", "0111111111100000", "0100000000100000", "0100000000100000", "0111111111100000", "0000000000000000"]);
    let after = rows(&["0000000000000000", "0111111111110000", "0110000000110000", "0100000000100000", "0111101111100000", "0000000000000000"]);
    for number in 0..2u8 {
        let (coding, refer, at) = refinement_template(number);
        let (offsets, generic_at) = template(0);
        let mut stream = page_information(16, 6);
        stream.extend(generic_region(16, 6, 0, 0, 0, &generic_at, &encode_generic(&before, &offsets)));
        let mut data = region_info(16, 6, 0, 0, 4); // combined with REPLACE
        data.push(number); // GRTEMPLATE, no typical prediction
        data.extend(at);
        data.extend(encode_refinement(&after, &before, &coding, &refer));
        stream.extend(segment_with(2, 42, &[], &data));
        let decoded = jbig2::decode(&stream, 16, 6, None).unwrap_or_else(|e| panic!("template {number}: {e}"));
        assert_eq!(decoded, packed(&after), "template {number}");
    }
}

/// The integer coding of T.88 Annex A.2 over contexts from `base`: a sign, a prefix choosing the range and the bits of
/// the offset in it; `None` is the out-of-band value (a negative zero).
pub(crate) fn encode_integer(coder: &mut MqEncoder, base: usize, value: Option<i64>) {
    let mut previous = 1usize;
    let mut put = |coder: &mut MqEncoder, bit: u8| {
        coder.encode(base + previous, bit);
        previous = if previous < 256 { (previous << 1) | usize::from(bit) } else { (((previous << 1) | usize::from(bit)) & 511) | 256 };
    };
    let bits = |coder: &mut MqEncoder, put: &mut dyn FnMut(&mut MqEncoder, u8), value: u64, count: u32| {
        for shift in (0..count).rev() {
            put(coder, ((value >> shift) & 1) as u8);
        }
    };
    let Some(value) = value else {
        for bit in [1, 0, 0, 0] {
            put(coder, bit);
        }
        return;
    };
    put(coder, u8::from(value < 0));
    let magnitude = value.unsigned_abs();
    let (prefix, offset, count): (&[u8], u64, u32) = match magnitude {
        0..=3 => (&[0], magnitude, 2),
        4..=19 => (&[1, 0], magnitude - 4, 4),
        20..=83 => (&[1, 1, 0], magnitude - 20, 6),
        84..=339 => (&[1, 1, 1, 0], magnitude - 84, 8),
        340..=4435 => (&[1, 1, 1, 1, 0], magnitude - 340, 12),
        _ => (&[1, 1, 1, 1, 1], magnitude - 4436, 32),
    };
    for &bit in prefix {
        put(coder, bit);
    }
    bits(coder, &mut put, offset, count);
}

/// The symbols' bitmaps for the dictionary and text tests: two of height 4 and one of height 6.
pub(crate) fn symbols() -> Vec<Vec<Vec<u8>>> {
    vec![rows(&["010", "111", "101", "101"]), rows(&["11111", "10001", "10001", "11111"]), rows(&["1001", "1001", "1111", "1001", "1001", "1001"])]
}

pub(crate) const GENERIC_CONTEXTS: usize = 1 << 16;

/// A symbol dictionary (type 0) of arithmetic-coded symbols without refinement, all exported (6.5): height classes in
/// increasing height, each a delta height, then for every symbol its delta width and its bitmap, then an out-of-band
/// width; at the end the export flags as runs (none skipped, then all exported).
pub(crate) fn symbol_dictionary(number: u32, symbols: &[Vec<Vec<u8>>]) -> Vec<u8> {
    let (offsets, at) = template(0);
    let (heights, widths, exports) = (GENERIC_CONTEXTS, GENERIC_CONTEXTS + 512, GENERIC_CONTEXTS + 1024);
    let mut coder = MqEncoder::new(GENERIC_CONTEXTS + 1536, &[]);
    let (mut class_height, mut index) = (0i64, 0);
    while index < symbols.len() {
        let height = symbols[index].len() as i64;
        encode_integer(&mut coder, heights, Some(height - class_height));
        class_height = height;
        let mut width = 0i64;
        while index < symbols.len() && symbols[index].len() as i64 == height {
            let symbol = &symbols[index];
            encode_integer(&mut coder, widths, Some(symbol[0].len() as i64 - width));
            width = symbol[0].len() as i64;
            for y in 0..symbol.len() as i32 {
                for x in 0..symbol[0].len() as i32 {
                    let context = offsets.iter().enumerate().fold(0, |acc, (k, (dx, dy))| acc | (pixel(symbol, x + dx, y + dy) << k));
                    coder.encode(context, symbol[y as usize][x as usize]);
                }
            }
            index += 1;
        }
        encode_integer(&mut coder, widths, None);
    }
    encode_integer(&mut coder, exports, Some(0));
    encode_integer(&mut coder, exports, Some(symbols.len() as i64));
    let mut data = vec![0, 0]; // arithmetic coding, no refinement, template 0
    data.extend(at);
    data.extend(be32(symbols.len() as u32));
    data.extend(be32(symbols.len() as u32));
    data.extend(coder.finish(true));
    segment_with(number, 0, &[], &data)
}

/// The strips of the text tests: `(top, [(symbol, left)])`, symbols placed by their top left corner.
pub(crate) fn strips() -> Vec<(i64, Vec<(usize, i64)>)> {
    vec![(0, vec![(0, 1), (1, 6)]), (6, vec![(2, 2), (0, 8), (1, 11)])]
}

/// The text region (type 6) fields before the data: placement, flags, instance count.
pub(crate) fn text_region_head(flags: u16, huffman_flags: Option<u16>, instances: u32) -> Vec<u8> {
    let mut data = region_info(16, 12, 0, 0, 0);
    data.extend(flags.to_be_bytes());
    if let Some(huffman) = huffman_flags {
        data.extend(huffman.to_be_bytes());
    }
    data.extend(be32(instances));
    data
}

pub(crate) fn iaid(coder: &mut MqEncoder, base: usize, bits: usize, id: usize) {
    let mut previous = 1usize;
    for shift in (0..bits).rev() {
        let bit = ((id >> shift) & 1) as u8;
        coder.encode(base + previous, bit);
        previous = (previous << 1) | usize::from(bit);
    }
}

/// `n` symbols need this many bits for their numbers.
pub(crate) fn code_length(n: usize) -> usize {
    if n < 2 { 0 } else { (usize::BITS - (n - 1).leading_zeros()) as usize }
}

pub(crate) type Strips = Vec<(i64, Vec<(usize, i64)>)>;

pub(crate) fn page_of_text(symbols: &[Vec<Vec<u8>>], strips: &Strips) -> Vec<Vec<u8>> {
    let mut canvas = vec![vec![0u8; 16]; 12];
    for (top, placed) in strips {
        for &(id, left) in placed {
            place(&mut canvas, &symbols[id], left as usize, *top as usize);
        }
    }
    canvas
}

/// A text region (type 6, segment 2) over `symbols` (what the referred dictionaries export, in order), coded with
/// the arithmetic integer coders: the strip times, the first position of each strip, the steps between the symbols of a
/// strip, an out-of-band step ending it, and each symbol's number in as many bits as the symbols need.
pub(crate) fn arithmetic_text_segment(number: u32, symbols: &[Vec<Vec<u8>>], strips: &Strips, referred: &[u32]) -> Vec<u8> {
    let (strip_times, first_positions, deltas, ids) = (0usize, 512usize, 1024usize, 1536usize);
    let bits = code_length(symbols.len());
    let mut coder = MqEncoder::new(1536 + (2usize << bits), &[]);
    encode_integer(&mut coder, strip_times, Some(0)); // the starting strip time
    let (mut top, mut first) = (0i64, 0i64);
    let mut instances = 0;
    for (strip_top, placed) in strips {
        encode_integer(&mut coder, strip_times, Some(strip_top - top));
        top = *strip_top;
        let mut cursor = 0i64;
        for (k, &(id, left)) in placed.iter().enumerate() {
            if k == 0 {
                encode_integer(&mut coder, first_positions, Some(left - first));
                first = left;
            } else {
                encode_integer(&mut coder, deltas, Some(left - cursor));
            }
            iaid(&mut coder, ids, bits, id);
            cursor = left + symbols[id][0].len() as i64 - 1;
            instances += 1;
        }
        encode_integer(&mut coder, deltas, None); // the end of the strip
    }
    // Arithmetic, no refinement, strips of one row, reference corner top left (1), the rest zero.
    let mut data = text_region_head(0x0010, None, instances);
    data.extend(coder.finish(true));
    segment_with(number, 6, referred, &data)
}

#[test]
pub(crate) fn an_arithmetic_text_region_places_the_symbols_of_a_dictionary() {
    let symbols = symbols();
    let mut stream = page_information(16, 12);
    stream.extend(symbol_dictionary(1, &symbols));
    stream.extend(arithmetic_text_segment(2, &symbols, &strips(), &[1]));
    let decoded = jbig2::decode(&stream, 16, 12, None).expect("decodes");
    assert_eq!(decoded, packed(&page_of_text(&symbols, &strips())));
}
/// A standard Huffman table of T.88 Annex B as lines of (prefix length, range length, range low); a table with an
/// out-of-band value has it as its last line.
pub(crate) type Lines = &'static [(u32, u32, i32)];

/// Table B.6 (first symbol positions), B.8 (position steps, with out-of-band) and B.11 (strip steps).
pub(crate) const B6: Lines = &[
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
];
pub(crate) const B8: Lines = &[
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
];
pub(crate) const B11: Lines = &[
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
];

/// The prefix codes of a table (B.3): by increasing length, and in the order of the lines within a length.
pub(crate) fn prefix_codes(lines: &[(u32, u32, i32)]) -> Vec<String> {
    let longest = lines.iter().map(|l| l.0).max().unwrap_or(0);
    let mut codes = vec![String::new(); lines.len()];
    let (mut first, mut previous_count) = (0u32, 0u32);
    for length in 1..=longest {
        first = (first + previous_count) << 1;
        let mut next = first;
        previous_count = 0;
        for (index, line) in lines.iter().enumerate() {
            if line.0 == length {
                codes[index] = format!("{next:0width$b}", width = length as usize);
                next += 1;
                previous_count += 1;
            }
        }
    }
    codes
}

/// The code of `value` (an ordinary range) or, with `None`, of the out-of-band line.
pub(crate) fn huffman(lines: &[(u32, u32, i32)], value: Option<i32>) -> String {
    let codes = prefix_codes(lines);
    let Some(value) = value else { return codes[lines.len() - 1].clone() };
    let (index, line) = lines
        .iter()
        .enumerate()
        .find(|(_, l)| l.0 > 0 && l.1 < 32 && value >= l.2 && i64::from(value) < i64::from(l.2) + (1i64 << l.1))
        .expect("a value inside a range");
    let offset = if line.1 == 0 { String::new() } else { format!("{:0width$b}", value - line.2, width = line.1 as usize) };
    format!("{}{offset}", codes[index])
}

/// A text region (type 6, segment 2) of the three symbols of [`symbols`] coded with Huffman tables: the symbol codes
/// 0, 10, 11 (lengths 1, 2, 2) are sent as 35 four-bit lengths for the run codes 0 to 34 (only run codes 1 and 2 are
/// used, one bit each, so 1 is `0` and 2 is `1`), then the symbols' lengths as run codes, then padding to a byte;
/// then the strips with tables B.11, B.6 and B.8.
pub(crate) fn huffman_text_segment(number: u32, symbols: &[Vec<Vec<u8>>], strips: &Strips, referred: &[u32]) -> Vec<u8> {
    let mut bits = String::new();
    for run_code in 0..35 {
        bits.push_str(&format!("{:04b}", u8::from(run_code == 1 || run_code == 2)));
    }
    bits.push_str("011");
    while bits.len() % 8 != 0 {
        bits.push('0');
    }
    let symbol_code = ["0", "10", "11"];
    // Strip times start at 1 in table B.11, so the start is one strip above the first, which is at time 0.
    bits.push_str(&huffman(B11, Some(1)));
    let (mut top, mut first) = (-1i64, 0i64);
    let mut instances = 0;
    for (strip_top, placed) in strips {
        bits.push_str(&huffman(B11, Some((strip_top - top) as i32)));
        top = *strip_top;
        let mut cursor = 0i64;
        for (k, &(id, left)) in placed.iter().enumerate() {
            if k == 0 {
                bits.push_str(&huffman(B6, Some((left - first) as i32)));
                first = left;
            } else {
                bits.push_str(&huffman(B8, Some((left - cursor) as i32)));
            }
            bits.push_str(symbol_code[id]);
            cursor = left + symbols[id][0].len() as i64 - 1;
            instances += 1;
        }
        bits.push_str(&huffman(B8, None));
    }
    // Huffman coding, strips of one row, reference corner top left; the tables B.6, B.8 and B.11 are the first choices.
    let mut data = text_region_head(0x0011, Some(0), instances);
    data.extend(pack_bits(&bits));
    segment_with(number, 6, referred, &data)
}

#[test]
pub(crate) fn a_huffman_text_region_with_the_standard_tables_places_the_symbols() {
    let symbols = symbols();
    let mut stream = page_information(16, 12);
    stream.extend(symbol_dictionary(1, &symbols));
    stream.extend(huffman_text_segment(2, &symbols, &strips(), &[1]));
    let decoded = jbig2::decode(&stream, 16, 12, None).expect("decodes");
    assert_eq!(decoded, packed(&page_of_text(&symbols, &strips())));
}

/// The pixels a refinement template looks at, in the order of its context bits: those of the new bitmap, then those of
/// the reference (the adaptive pixels last in each, at their nominal places), and the bytes of the adaptive pixels.
pub(crate) type RefinementTemplate = (Vec<(i32, i32)>, Vec<(i32, i32)>, Vec<u8>);

pub(crate) fn refinement_template(number: u8) -> RefinementTemplate {
    if number == 0 {
        (
            vec![(0, -1), (1, -1), (-1, 0), (-1, -1)],
            vec![(0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (-1, 1), (0, 1), (1, 1), (-1, -1)],
            vec![0xFF, 0xFF, 0xFF, 0xFF],
        )
    } else {
        (vec![(-1, -1), (0, -1), (1, -1), (-1, 0)], vec![(0, -1), (-1, 0), (0, 0), (1, 0), (0, 1), (1, 1)], vec![])
    }
}

pub(crate) fn refinement_pair() -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let before = rows(&["0000000000000000", "0111111111100000", "0100000000100000", "0100000000100000", "0111111111100000", "0000000000000000"]);
    let after = rows(&["0000000000000000", "0111111111110000", "0110000000110000", "0100000000100000", "0111101111100000", "0000000000000010"]);
    (before, after)
}

#[test]
pub(crate) fn typical_prediction_in_a_refinement_region_leaves_out_the_pixels_the_reference_decides() {
    // With typical prediction a row either repeats the reference where its 3 x 3 neighbourhood is one colour (then
    // those pixels are not coded at all) or is coded in full; a bit before each row says which. Row 5 has a black
    // pixel where the reference is white all around, so it is coded in full; the others are typical. The bit's
    // context is the one with only the centre reference pixel set.
    let (before, after) = refinement_pair();
    for (number, sltp) in [(0u8, 0x0020usize), (1, 0x0008)] {
        let (coding, refer, at) = refinement_template(number);
        let uniform = |x: i32, y: i32| -> Option<usize> {
            let value = pixel(&before, x, y);
            (-1..=1).all(|dy| (-1..=1).all(|dx| pixel(&before, x + dx, y + dy) == value)).then_some(value)
        };
        let mut coder = MqEncoder::new(1 << (coding.len() + refer.len()), &[]);
        let mut previous = 0u8;
        let mut typical_rows = 0;
        for y in 0..after.len() as i32 {
            let typical = (0..16).all(|x| uniform(x, y).is_none_or(|v| v == pixel(&after, x, y)));
            typical_rows += usize::from(typical);
            coder.encode(sltp, u8::from(typical) ^ previous);
            previous = u8::from(typical);
            for x in 0..16 {
                if typical && uniform(x, y).is_some() {
                    continue;
                }
                let mut context = coding.iter().fold(0, |acc, &(dx, dy)| (acc << 1) | pixel(&after, x + dx, y + dy));
                context = refer.iter().fold(context, |acc, &(dx, dy)| (acc << 1) | pixel(&before, x + dx, y + dy));
                coder.encode(context, after[y as usize][x as usize]);
            }
        }
        assert_eq!(typical_rows, 5, "the test needs rows of both kinds");
        let (offsets, generic_at) = template(0);
        let mut stream = page_information(16, 6);
        stream.extend(generic_region(16, 6, 0, 0, 0, &generic_at, &encode_generic(&before, &offsets)));
        let mut data = region_info(16, 6, 0, 0, 4);
        data.push(number | 2); // the template and typical prediction
        data.extend(at);
        data.extend(coder.finish(true));
        stream.extend(segment_with(2, 42, &[], &data));
        let decoded = jbig2::decode(&stream, 16, 6, None).unwrap_or_else(|e| panic!("template {number}: {e}"));
        assert_eq!(decoded, packed(&after), "template {number}");
    }
}

/// A symbol dictionary of arithmetic-coded symbols that are refinements and aggregates of the symbols of an earlier
/// dictionary (6.5.8.2) exporting only its two new symbols: the first refines symbol 1 of the input, the second is
/// symbol 0 and symbol 2 of the input drawn side by side (an aggregate of two instances, coded as a small text region).
#[test]
pub(crate) fn a_symbol_dictionary_may_refine_and_aggregate_the_symbols_it_inherits() {
    let input = symbols();
    let refined = rows(&["11111", "11001", "10011", "11111"]);
    let mut aggregate = vec![vec![0u8; 7]; 6];
    place(&mut aggregate, &input[0], 0, 0);
    place(&mut aggregate, &input[2], 3, 0);
    let new = [refined.clone(), aggregate.clone()];

    let [heights, widths, exports, aggregate_counts] = [0usize, 512, 1024, 1536];
    let [strip_times, first_positions, deltas, refined_flags, ref_dx, ref_dy] = [2048usize, 2560, 3072, 3584, 4096, 4608];
    let ids = 5120usize;
    let bits = code_length(5); // three input symbols and two new ones
    let refinement = ids + (2usize << bits);
    let (coding, refer, at) = refinement_template(0);
    let mut coder = MqEncoder::new(refinement + (1 << 13), &[]);
    // Class of height 4: the refinement. Its width step, one instance, the input symbol (1), the offset (0, 0), and the
    // refinement of the bitmap against that symbol.
    encode_integer(&mut coder, heights, Some(4));
    encode_integer(&mut coder, widths, Some(5));
    encode_integer(&mut coder, aggregate_counts, Some(1));
    iaid(&mut coder, ids, bits, 1);
    encode_integer(&mut coder, ref_dx, Some(0));
    encode_integer(&mut coder, ref_dy, Some(0));
    for y in 0..4i32 {
        for x in 0..5i32 {
            let mut context = coding.iter().fold(0, |acc, &(dx, dy)| (acc << 1) | pixel(&refined, x + dx, y + dy));
            context = refer.iter().fold(context, |acc, &(dx, dy)| (acc << 1) | pixel(&input[1], x + dx, y + dy));
            coder.encode(refinement + context, refined[y as usize][x as usize]);
        }
    }
    encode_integer(&mut coder, widths, None);
    // Class of height 6: the aggregate of input symbols 0 and 2, a strip of two instances placed at 0 and 3.
    encode_integer(&mut coder, heights, Some(2));
    encode_integer(&mut coder, widths, Some(7)); // widths count from zero in each class
    encode_integer(&mut coder, aggregate_counts, Some(2));
    encode_integer(&mut coder, strip_times, Some(0));
    encode_integer(&mut coder, strip_times, Some(0));
    for (k, id) in [0usize, 2].into_iter().enumerate() {
        if k == 0 {
            encode_integer(&mut coder, first_positions, Some(0));
        } else {
            encode_integer(&mut coder, deltas, Some(1)); // after symbol 0 (3 wide) the cursor is at 2
        }
        iaid(&mut coder, ids, bits, id);
        encode_integer(&mut coder, refined_flags, Some(0)); // not refined
    }
    encode_integer(&mut coder, deltas, None);
    encode_integer(&mut coder, widths, None);
    // The export flags: the three input symbols are not exported, the two new ones are.
    encode_integer(&mut coder, exports, Some(3));
    encode_integer(&mut coder, exports, Some(2));

    let (_, generic_at) = template(0);
    let mut data = vec![0x00, 0x02]; // arithmetic, with refinement and aggregation, template 0
    data.extend(generic_at);
    data.extend(at);
    data.extend(be32(2));
    data.extend(be32(2));
    data.extend(coder.finish(true));
    let mut stream = page_information(16, 12);
    stream.extend(symbol_dictionary(1, &input));
    stream.extend(segment_with(2, 0, &[1], &data));
    let placed: Strips = vec![(0, vec![(0, 1), (1, 8)])];
    stream.extend(arithmetic_text_segment(3, &new, &placed, &[2]));
    let decoded = jbig2::decode(&stream, 16, 12, None).expect("decodes");
    assert_eq!(decoded, packed(&page_of_text(&new, &placed)));
}

pub(crate) const B1: Lines = &[(1, 4, 0), (2, 8, 16), (3, 16, 272), (0, 32, -1), (3, 32, 65808)];
pub(crate) const B2: Lines = &[(1, 0, 0), (2, 0, 1), (3, 0, 2), (4, 3, 3), (5, 6, 11), (0, 32, -1), (6, 32, 75), (6, 0, 0)];
pub(crate) const B4: Lines = &[(1, 0, 1), (2, 0, 2), (3, 0, 3), (4, 3, 4), (5, 6, 12), (0, 32, 0), (5, 32, 76)];

/// A symbol dictionary coded with Huffman tables (6.5 with SDHUFF): per height class the delta height (B.4), the
/// delta widths (B.2, then out-of-band), the size of the collective bitmap of the class (B.1; 0 says it follows
/// uncompressed, each row padded to a byte) and that bitmap; at the end the export runs (B.1).
pub(crate) fn huffman_symbol_dictionary(number: u32, symbols: &[Vec<Vec<u8>>]) -> Vec<u8> {
    let mut bits = String::new();
    let (mut class_height, mut index) = (0i32, 0);
    while index < symbols.len() {
        let height = symbols[index].len() as i32;
        bits.push_str(&huffman(B4, Some(height - class_height)));
        class_height = height;
        let first = index;
        let mut width = 0i32;
        while index < symbols.len() && symbols[index].len() as i32 == height {
            let w = symbols[index][0].len() as i32;
            bits.push_str(&huffman(B2, Some(w - width)));
            width = w;
            index += 1;
        }
        bits.push_str(&huffman(B2, None));
        bits.push_str(&huffman(B1, Some(0))); // the bitmap follows uncompressed
        while bits.len() % 8 != 0 {
            bits.push('0');
        }
        for y in 0..height as usize {
            for symbol in &symbols[first..index] {
                bits.extend(symbol[y].iter().map(|&p| char::from(b'0' + p)));
            }
            while bits.len() % 8 != 0 {
                bits.push('0');
            }
        }
    }
    bits.push_str(&huffman(B1, Some(0)));
    bits.push_str(&huffman(B1, Some(symbols.len() as i32)));
    let mut data = vec![0x00, 0x01]; // Huffman coding with the first choice of every table
    data.extend(be32(symbols.len() as u32));
    data.extend(be32(symbols.len() as u32));
    data.extend(pack_bits(&bits));
    segment_with(number, 0, &[], &data)
}

#[test]
pub(crate) fn a_huffman_coded_symbol_dictionary_gives_the_same_symbols() {
    let symbols = symbols();
    let mut stream = page_information(16, 12);
    stream.extend(huffman_symbol_dictionary(1, &symbols));
    stream.extend(arithmetic_text_segment(2, &symbols, &strips(), &[1]));
    let decoded = jbig2::decode(&stream, 16, 12, None).expect("decodes");
    assert_eq!(decoded, packed(&page_of_text(&symbols, &strips())));
}

pub(crate) const WHITE_RUNS: [&str; 8] = ["00110101", "000111", "0111", "1000", "1011", "1100", "1110", "1111"];
pub(crate) const BLACK_RUNS: [&str; 8] = ["0000110111", "010", "11", "10", "011", "0011", "0010", "00011"];

/// The MMR (T.6) code of a bitmap whose runs are shorter than 8: the modes of each row against the row above (pass,
/// vertical, horizontal), then the end-of-block code.
pub(crate) fn t6(bitmap: &[Vec<u8>]) -> String {
    let width = bitmap[0].len() as i64;
    let get = |row: &[u8], x: i64| if x < 0 || x >= width { 0 } else { row[x as usize] };
    let mut out = String::new();
    let mut reference = vec![0u8; width as usize];
    for row in bitmap {
        let (mut a0, mut colour) = (-1i64, 0u8);
        while a0 < width {
            let a1 = (a0 + 1..width).find(|&x| get(row, x) != colour).unwrap_or(width);
            let b1 = (a0 + 1..width).find(|&x| get(&reference, x) != colour && get(&reference, x - 1) == colour).unwrap_or(width);
            let b2 = (b1 + 1..width).find(|&x| get(&reference, x) == colour).unwrap_or(width);
            if b2 < a1 {
                out.push_str("0001");
                a0 = b2;
            } else if (a1 - b1).abs() <= 3 {
                out.push_str(match a1 - b1 {
                    0 => "1",
                    1 => "011",
                    2 => "000011",
                    3 => "0000011",
                    -1 => "010",
                    -2 => "000010",
                    _ => "0000010",
                });
                a0 = a1;
                colour ^= 1;
            } else {
                let a2 = (a1 + 1..width).find(|&x| get(row, x) == colour).unwrap_or(width);
                let run = |colour: u8, length: i64| if colour == 0 { WHITE_RUNS[length as usize] } else { BLACK_RUNS[length as usize] };
                out.push_str("001");
                out.push_str(run(colour, a1 - a0.max(0)));
                out.push_str(run(1 - colour, a2 - a1));
                a0 = a2;
            }
        }
        reference = row.clone();
    }
    out.push_str("000000000001000000000001");
    out
}

#[test]
pub(crate) fn a_halftone_region_draws_a_pattern_for_each_gray_value_of_its_grid() {
    let patterns = [
        rows(&["0000", "0000", "0000", "0000"]),
        rows(&["1000", "0100", "0010", "0001"]),
        rows(&["1100", "1100", "0011", "0011"]),
        rows(&["1111", "1111", "1111", "1111"]),
    ];
    let grid = [[0usize, 1, 2], [3, 2, 1]];
    // The pattern dictionary: the patterns side by side as one bitmap, coded as a generic region of template 1 whose
    // first adaptive pixel is (-pattern width, 0).
    let collective: Vec<Vec<u8>> = (0..4).map(|y| patterns.iter().flat_map(|p| p[y].clone()).collect()).collect();
    let (mut dictionary_offsets, _) = template(1);
    dictionary_offsets.retain(|&o| o != (3, -1));
    dictionary_offsets.push((-4, 0));
    let mut dictionary = vec![0b010, 4, 4];
    dictionary.extend(be32(3));
    dictionary.extend(encode_generic(&collective, &dictionary_offsets));
    // The grid of gray values as two bit planes, the more significant first, each plane after it exclusive-or'd with
    // the plane above (a Gray code).
    let high: Vec<Vec<u8>> = grid.iter().map(|row| row.iter().map(|&g| (g >> 1) as u8).collect()).collect();
    let low: Vec<Vec<u8>> = grid.iter().map(|row| row.iter().map(|&g| ((g & 1) ^ (g >> 1)) as u8).collect()).collect();
    for mmr in [false, true] {
        let (flags, planes) = if mmr {
            // MMR: each plane is its own T.6 stream, ending in the end-of-block code and padded to a byte.
            let mut bytes = Vec::new();
            for plane in [&high, &low] {
                bytes.extend(pack_bits(&t6(plane)));
            }
            (0b001u8, bytes)
        } else {
            // Arithmetic: one coder and one set of contexts for both planes, template 1.
            let (offsets, _) = template(1);
            let mut coder = MqEncoder::new(1 << offsets.len(), &[]);
            for plane in [&high, &low] {
                for y in 0..2i32 {
                    for x in 0..3i32 {
                        let context = offsets.iter().enumerate().fold(0, |acc, (k, (dx, dy))| acc | (pixel(plane, x + dx, y + dy) << k));
                        coder.encode(context, plane[y as usize][x as usize]);
                    }
                }
            }
            (0b010, coder.finish(true))
        };
        // No skip, OR, default pixel 0; a 3 x 2 grid at the origin stepping 4 pixels across.
        let mut region = region_info(12, 8, 0, 0, 0);
        region.push(flags);
        region.extend(be32(3));
        region.extend(be32(2));
        region.extend(be32(0));
        region.extend(be32(0));
        region.extend((4u16 << 8).to_be_bytes());
        region.extend(0u16.to_be_bytes());
        region.extend(planes);
        let mut stream = page_information(12, 8);
        stream.extend(segment_with(1, 16, &[], &dictionary));
        stream.extend(segment_with(2, 22, &[1], &region));
        let decoded = jbig2::decode(&stream, 12, 8, None).unwrap_or_else(|e| panic!("mmr {mmr}: {e}"));
        let mut expected = vec![vec![0u8; 12]; 8];
        for (m, row) in grid.iter().enumerate() {
            for (n, &gray) in row.iter().enumerate() {
                place(&mut expected, &patterns[gray], 4 * n, 4 * m);
            }
        }
        assert_eq!(decoded, packed(&expected), "mmr {mmr}");
    }
}
