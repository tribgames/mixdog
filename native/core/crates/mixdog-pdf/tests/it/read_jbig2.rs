//! The JBIG2 decoder's coding variants end to end, on streams built here (T.88): adaptive template pixels anywhere,
//! the combination operators, unknown-length regions, refinement of every kind of intermediate region, text regions
//! in both coding modes with every strip size, reference corner, orientation, combination operator and refinement,
//! custom Huffman tables, symbol dictionaries of every kind, and halftone regions with every template, skipping and
//! grid orientation. The expected bitmaps are the inputs.

use mixdog_pdf::codec::jbig2;

use crate::read_codecs::*;
use crate::read_support::{MqEncoder, pack_bits};

fn page(width: u32, height: u32, flags: u8) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend(be32(width));
    data.extend(be32(height));
    data.extend([0; 8]);
    data.push(flags);
    data.extend([0, 0]);
    segment(0, 48, &data)
}

fn generic_body(width: usize, height: usize, x: usize, y: usize, op: u8, flags: u8, at: &[u8], coded: &[u8]) -> Vec<u8> {
    let mut data = region_info(width, height, x, y, op);
    data.push(flags);
    data.extend_from_slice(at);
    data.extend_from_slice(coded);
    data
}

/// `bitmap` drawn onto `canvas` at (`x`, `y`) with the combination operator `op` (0 or, 1 and, 2 xor, 3 xnor,
/// 4 replace); what falls outside the canvas is cut off.
fn compose(canvas: &mut [Vec<u8>], bitmap: &[Vec<u8>], x: i64, y: i64, op: u8) {
    for (row, pixels) in bitmap.iter().enumerate() {
        for (column, &r) in pixels.iter().enumerate() {
            let (cx, cy) = (column as i64 + x, row as i64 + y);
            if cx < 0 || cy < 0 || cy as usize >= canvas.len() || cx as usize >= canvas[0].len() {
                continue;
            }
            let old = canvas[cy as usize][cx as usize];
            canvas[cy as usize][cx as usize] = match op {
                0 => old | r,
                1 => old & r,
                2 => old ^ r,
                3 => 1 - (old ^ r),
                _ => r,
            };
        }
    }
}

fn decoded(stream: &[u8], width: i32, height: i32) -> Vec<u8> {
    jbig2::decode(stream, width, height, None).expect("the stream decodes")
}

// ---- generic regions ------------------------------------------------------------------------------------------------

/// The template's pixels with the adaptive pixels moved to other places of the area already coded, and the bytes that
/// say where they are.
fn custom_template(number: u8) -> (Vec<(i32, i32)>, Vec<u8>) {
    let (mut offsets, _) = template(number);
    let (slots, custom): (&[usize], &[(i32, i32)]) = match number {
        0 => (&[11, 10, 4, 3], &[(4, -2), (-5, -1), (1, -3), (-6, 0)]),
        1 => (&[9], &[(3, -2)]),
        2 => (&[7], &[(-3, -2)]),
        _ => (&[5], &[(-5, -1)]),
    };
    for (&slot, &place) in slots.iter().zip(custom) {
        offsets[slot] = place;
    }
    (offsets, custom.iter().flat_map(|&(x, y)| [x as i8 as u8, y as i8 as u8]).collect())
}

#[test]
fn adaptive_template_pixels_may_lie_anywhere_in_the_area_already_coded() {
    let black = bitmap();
    for number in 0..4u8 {
        let (offsets, at) = custom_template(number);
        let mut stream = page(16, 6, 0);
        stream.extend(generic_region(16, 6, 0, 0, number << 1, &at, &encode_generic(&black, &offsets)));
        assert_eq!(decoded(&stream, 16, 6), packed(&black), "template {number}");
    }
}

#[test]
fn a_region_of_unknown_length_and_a_lossless_region_are_read_like_any_other() {
    let black = bitmap();
    let (offsets, at) = template(0);
    let coded = encode_generic(&black, &offsets);
    // Type 39 (immediate lossless).
    let mut stream = page(16, 6, 0);
    stream.extend(segment(1, 39, &generic_body(16, 6, 0, 0, 0, 0, &at, &coded)));
    assert_eq!(decoded(&stream, 16, 6), packed(&black));
    // Type 38 with the length 0xFFFFFFFF: the data ends with the marker of the arithmetic code and then a four byte row
    // count. A second region that exclusive-ors the same bitmap follows and leaves the page white.
    let mut unknown = Vec::new();
    unknown.extend(be32(1));
    unknown.extend([38, 0, 1]);
    unknown.extend(be32(u32::MAX));
    unknown.extend(generic_body(16, 6, 0, 0, 0, 0, &at, &coded));
    unknown.extend(be32(6));
    let mut stream = page(16, 6, 0);
    stream.extend(unknown);
    stream.extend(segment(2, 38, &generic_body(16, 6, 0, 0, 2, 0, &at, &coded)));
    assert_eq!(decoded(&stream, 16, 6), packed(&vec![vec![0u8; 16]; 6]));
}

#[test]
fn every_combination_operator_acts_on_a_white_or_a_black_page() {
    let black = bitmap();
    let (offsets, at) = template(0);
    let coded = encode_generic(&black, &offsets);
    for default in [0u8, 1] {
        for op in 0..5u8 {
            let mut stream = page(20, 8, default << 2);
            stream.extend(segment(1, 38, &generic_body(16, 6, 2, 1, op, 0, &at, &coded)));
            let mut canvas = vec![vec![default; 20]; 8];
            compose(&mut canvas, &black, 2, 1, op);
            // The unused bits at the end of a row hold the page's default pixel.
            let padded: Vec<Vec<u8>> = canvas.iter().map(|row| [row.clone(), vec![default; 4]].concat()).collect();
            assert_eq!(decoded(&stream, 20, 8), packed(&padded), "default {default}, operator {op}");
        }
    }
}

// ---- refinement of intermediate regions -------------------------------------------------------------------------------

fn refinement_body(info: Vec<u8>, flags: u8, at: &[u8], coded: Vec<u8>) -> Vec<u8> {
    let mut data = info;
    data.push(flags);
    data.extend_from_slice(at);
    data.extend(coded);
    data
}

/// Template 0 with its two adaptive pixels moved: one in the new bitmap, one in the reference.
fn custom_refinement_template() -> RefinementTemplate {
    let (mut coding, mut refer, _) = refinement_template(0);
    *coding.last_mut().unwrap() = (-2, -1);
    *refer.last_mut().unwrap() = (-2, 1);
    (coding, refer, vec![(-2i8) as u8, (-1i8) as u8, (-2i8) as u8, 1])
}

#[test]
fn a_refinement_region_refines_an_intermediate_region_it_refers_to() {
    let (before, after) = refinement_pair();
    let mut third = after.clone();
    third[2][8] = 1;
    third[4][1] = 1;
    let (offsets, generic_at) = template(0);
    let intermediate = |kind: u8| segment_with(1, kind, &[], &generic_body(16, 6, 0, 0, 0, 0, &generic_at, &encode_generic(&before, &offsets)));
    for custom in [false, true] {
        let (coding, refer, at) = if custom { custom_refinement_template() } else { refinement_template(0) };
        // Refining a generic intermediate region (type 36).
        let mut stream = page(16, 6, 0);
        stream.extend(intermediate(36));
        let data = refinement_body(region_info(16, 6, 0, 0, 4), 0, &at, encode_refinement(&after, &before, &coding, &refer));
        stream.extend(segment_with(2, 42, &[1], &data));
        assert_eq!(decoded(&stream, 16, 6), packed(&after), "custom {custom}");
        // Refining a refinement that is itself intermediate (type 40): before, then after, then the third bitmap.
        let mut stream = page(16, 6, 0);
        stream.extend(intermediate(36));
        let data = refinement_body(region_info(16, 6, 0, 0, 0), 0, &at, encode_refinement(&after, &before, &coding, &refer));
        stream.extend(segment_with(2, 40, &[1], &data));
        let data = refinement_body(region_info(16, 6, 0, 0, 4), 0, &at, encode_refinement(&third, &after, &coding, &refer));
        stream.extend(segment_with(3, 43, &[2], &data));
        assert_eq!(decoded(&stream, 16, 6), packed(&third), "custom {custom}, chained");
    }
}

#[test]
fn a_refinement_region_without_a_reference_refines_the_part_of_the_page_it_covers() {
    let (before, _) = refinement_pair();
    let (offsets, generic_at) = template(0);
    // A 10 x 4 region at (3, 1): the reference is that part of the page.
    let reference: Vec<Vec<u8>> = (1..5).map(|y| before[y][3..13].to_vec()).collect();
    let target = rows(&["0111111111", "0100110001", "0100000001", "0111111111"]);
    for number in 0..2u8 {
        let (coding, refer, at) = refinement_template(number);
        let mut stream = page(16, 6, 0);
        stream.extend(generic_region(16, 6, 0, 0, 0, &generic_at, &encode_generic(&before, &offsets)));
        let data = refinement_body(region_info(10, 4, 3, 1, 4), number, &at, encode_refinement(&target, &reference, &coding, &refer));
        stream.extend(segment_with(2, 42, &[], &data));
        let mut expected = before.clone();
        compose(&mut expected, &target, 3, 1, 4);
        assert_eq!(decoded(&stream, 16, 6), packed(&expected), "template {number}");
    }
}

// ---- text regions -----------------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Refined {
    bitmap: Vec<Vec<u8>>,
    rdx: i64,
    rdy: i64,
}

/// One symbol instance: which symbol, where its top left pixel goes, and the bitmap it is refined to, if any.
#[derive(Clone)]
struct Instance {
    id: usize,
    x: i64,
    y: i64,
    refined: Option<Refined>,
}

fn at(id: usize, x: i64, y: i64) -> Instance {
    Instance { id, x, y, refined: None }
}

#[derive(Clone)]
struct Text {
    width: usize,
    height: usize,
    /// 1, 2, 4 or 8.
    strips: i64,
    /// 0 bottom left, 1 top left, 2 bottom right, 3 top right.
    corner: u8,
    transposed: bool,
    op: u8,
    def_pixel: u8,
    ds_offset: i64,
    r_template: u8,
    refine: bool,
}

impl Text {
    fn new(width: usize, height: usize) -> Self {
        Text { width, height, strips: 1, corner: 1, transposed: false, op: 0, def_pixel: 0, ds_offset: 0, r_template: 0, refine: false }
    }

    fn flags(&self, huffman: bool) -> u16 {
        u16::from(huffman)
            | (u16::from(self.refine) << 1)
            | ((self.strips.trailing_zeros() as u16) << 2)
            | (u16::from(self.corner) << 4)
            | (u16::from(self.transposed) << 6)
            | (u16::from(self.op) << 7)
            | (u16::from(self.def_pixel) << 9)
            | (((self.ds_offset as u16) & 0x1f) << 10)
            | (u16::from(self.r_template) << 15)
    }

    fn head(&self, huffman_flags: Option<u16>, instances: usize) -> Vec<u8> {
        let mut data = region_info(self.width, self.height, 0, 0, 0);
        data.extend(self.flags(huffman_flags.is_some()).to_be_bytes());
        if let Some(flags) = huffman_flags {
            data.extend(flags.to_be_bytes());
        }
        if self.refine && self.r_template == 0 {
            data.extend(refinement_template(0).2);
        }
        data.extend(be32(instances as u32));
        data
    }
}

fn drawn<'a>(symbols: &'a [Vec<Vec<u8>>], instance: &'a Instance) -> &'a Vec<Vec<u8>> {
    instance.refined.as_ref().map_or(&symbols[instance.id], |r| &r.bitmap)
}

/// What the region has to say for an instance (6.4.5): the S coordinate it is coded as (before the reference corner is
/// added), the S coordinate the cursor is left at, and the T coordinate.
fn placement(text: &Text, bitmap: &[Vec<u8>], x: i64, y: i64) -> (i64, i64, i64) {
    let (h, w) = (bitmap.len() as i64, bitmap[0].len() as i64);
    let (rx, ry) = match text.corner {
        1 => (x, y),
        3 => (x + w - 1, y),
        0 => (x, y + h - 1),
        _ => (x + w - 1, y + h - 1),
    };
    let (s, t) = if text.transposed { (ry, rx) } else { (rx, ry) };
    let (right, bottom) = (matches!(text.corner, 2 | 3), matches!(text.corner, 0 | 2));
    let (offset, advance) = if text.transposed {
        (if bottom { h - 1 } else { 0 }, if bottom { 0 } else { h - 1 })
    } else {
        (if right { w - 1 } else { 0 }, if right { 0 } else { w - 1 })
    };
    (s - offset, s + advance, t)
}

fn expected_text(text: &Text, symbols: &[Vec<Vec<u8>>], instances: &[Instance]) -> Vec<Vec<u8>> {
    let mut canvas = vec![vec![text.def_pixel; text.width]; text.height];
    for instance in instances {
        compose(&mut canvas, drawn(symbols, instance), instance.x, instance.y, text.op);
    }
    canvas
}

/// The instances in the order the strips take them: by the strip their T coordinate is in.
fn by_strip(text: &Text, symbols: &[Vec<Vec<u8>>], instances: &[Instance]) -> Vec<(Instance, (i64, i64, i64))> {
    let mut placed: Vec<_> = instances.iter().map(|i| (i.clone(), placement(text, drawn(symbols, i), i.x, i.y))).collect();
    placed.sort_by_key(|(_, p)| p.2.div_euclid(text.strips));
    placed
}

/// The contexts of a refinement coded against `reference` shifted by (`dx`, `dy`), into `coder` from `base`.
fn encode_shifted(coder: &mut MqEncoder, base: usize, target: &[Vec<u8>], reference: &[Vec<u8>], shift: (i64, i64), template: &RefinementTemplate) {
    let (coding, refer, _) = template;
    for y in 0..target.len() as i32 {
        for x in 0..target[0].len() as i32 {
            let mut context = coding.iter().fold(0, |acc, &(ox, oy)| (acc << 1) | pixel(target, x + ox, y + oy));
            context = refer.iter().fold(context, |acc, &(ox, oy)| (acc << 1) | pixel(reference, x - shift.0 as i32 + ox, y - shift.1 as i32 + oy));
            coder.encode(base + context, target[y as usize][x as usize]);
        }
    }
}

fn iaid(coder: &mut MqEncoder, base: usize, bits: usize, id: usize) {
    let mut previous = 1usize;
    for shift in (0..bits).rev() {
        let bit = ((id >> shift) & 1) as u8;
        coder.encode(base + previous, bit);
        previous = (previous << 1) | usize::from(bit);
    }
}

/// An arithmetic coded text region segment of `kind` (4 intermediate, 6 immediate, 7 immediate lossless).
fn arithmetic_text(number: u32, kind: u8, text: &Text, symbols: &[Vec<Vec<u8>>], instances: &[Instance], referred: &[u32]) -> Vec<u8> {
    let bits = code_length(symbols.len());
    let [time, first, delta, within, flag, rdw, rdh, rdx, rdy] = [0usize, 512, 1024, 1536, 2048, 2560, 3072, 3584, 4096];
    let ids = 4608usize;
    let refinement = ids + (2usize << bits);
    let template = refinement_template(text.r_template);
    let mut coder = MqEncoder::new(refinement + (1 << 13), &[]);
    let placed = by_strip(text, symbols, instances);
    encode_integer(&mut coder, time, Some(0));
    let (mut current_strip, mut first_s) = (0i64, 0i64);
    let mut k = 0;
    while k < placed.len() {
        let strip = placed[k].1.2.div_euclid(text.strips);
        let end = placed[k..].iter().position(|p| p.1.2.div_euclid(text.strips) != strip).map_or(placed.len(), |n| k + n);
        encode_integer(&mut coder, time, Some(strip - current_strip));
        current_strip = strip;
        let mut cursor = 0;
        for (n, (instance, (coded, advance, t))) in placed[k..end].iter().enumerate() {
            if n == 0 {
                encode_integer(&mut coder, first, Some(coded - first_s));
                first_s = *coded;
            } else {
                encode_integer(&mut coder, delta, Some(coded - cursor - text.ds_offset));
            }
            if text.strips != 1 {
                encode_integer(&mut coder, within, Some(t - strip * text.strips));
            }
            iaid(&mut coder, ids, bits, instance.id);
            if text.refine {
                match &instance.refined {
                    None => encode_integer(&mut coder, flag, Some(0)),
                    Some(refined) => {
                        encode_integer(&mut coder, flag, Some(1));
                        let original = &symbols[instance.id];
                        let dw = refined.bitmap[0].len() as i64 - original[0].len() as i64;
                        let dh = refined.bitmap.len() as i64 - original.len() as i64;
                        for (base, value) in [(rdw, dw), (rdh, dh), (rdx, refined.rdx), (rdy, refined.rdy)] {
                            encode_integer(&mut coder, base, Some(value));
                        }
                        let shift = ((dw >> 1) + refined.rdx, (dh >> 1) + refined.rdy);
                        encode_shifted(&mut coder, refinement, &refined.bitmap, original, shift, &template);
                    }
                }
            }
            cursor = *advance;
        }
        encode_integer(&mut coder, delta, None);
        k = end;
    }
    let mut data = text.head(None, instances.len());
    data.extend(coder.finish(true));
    segment_with(number, kind, referred, &data)
}

fn text_instances() -> Vec<Instance> {
    vec![at(0, 1, 1), at(1, 7, 1), at(2, 2, 7), at(0, 9, 7), at(1, 14, 8)]
}

/// The refined versions of three of them: bigger, smaller and shifted by an odd amount.
fn refined_instances(symbols: &[Vec<Vec<u8>>]) -> Vec<Instance> {
    let bigger = rows(&["0110", "1001", "1111", "1001", "0110"]);
    let smaller = rows(&["1111", "1001", "1001", "1111"]);
    let same = rows(&["1001", "0110", "0110", "1001", "1111", "0000"]);
    assert_eq!((symbols[0].len(), symbols[1][0].len(), symbols[2].len()), (4, 5, 6));
    vec![
        Instance { refined: Some(Refined { bitmap: bigger, rdx: 0, rdy: 0 }), ..at(0, 1, 1) },
        at(1, 8, 1),
        Instance { refined: Some(Refined { bitmap: smaller, rdx: 1, rdy: -1 }), ..at(1, 14, 2) },
        Instance { refined: Some(Refined { bitmap: same, rdx: -1, rdy: 1 }), ..at(2, 3, 8) },
        at(0, 12, 9),
    ]
}

#[test]
fn an_arithmetic_text_region_places_symbols_by_every_corner_strip_size_and_orientation() {
    let symbols = symbols();
    // (strips, corner, transposed, operator, default pixel, offset of the steps)
    let cases = [
        (1, 1, false, 0, 0, 0),
        (2, 0, false, 2, 0, -3),
        (4, 2, false, 1, 1, 5),
        (8, 3, false, 3, 1, 15),
        (1, 0, true, 0, 0, -16),
        (2, 1, true, 2, 1, 3),
        (4, 3, true, 1, 1, 0),
        (8, 2, true, 3, 0, -1),
    ];
    for (strips, corner, transposed, op, def_pixel, ds_offset) in cases {
        let text = Text { strips, corner, transposed, op, def_pixel, ds_offset, ..Text::new(24, 16) };
        let instances = text_instances();
        let mut stream = page(24, 16, 0);
        stream.extend(symbol_dictionary(1, &symbols));
        stream.extend(arithmetic_text(2, 6, &text, &symbols, &instances, &[1]));
        let expected = expected_text(&text, &symbols, &instances);
        assert_eq!(decoded(&stream, 24, 16), packed(&expected), "strips {strips}, corner {corner}, transposed {transposed}, op {op}");
    }
}

#[test]
fn an_arithmetic_text_region_may_refine_each_symbol_it_places() {
    let symbols = symbols();
    let instances = refined_instances(&symbols);
    for r_template in 0..2u8 {
        for (strips, corner, transposed) in [(1, 1, false), (4, 3, true)] {
            let text = Text { refine: true, r_template, strips, corner, transposed, ..Text::new(24, 16) };
            let mut stream = page(24, 16, 0);
            stream.extend(symbol_dictionary(1, &symbols));
            stream.extend(arithmetic_text(2, 6, &text, &symbols, &instances, &[1]));
            let expected = expected_text(&text, &symbols, &instances);
            assert_eq!(decoded(&stream, 24, 16), packed(&expected), "template {r_template}, strips {strips}");
        }
    }
}

#[test]
fn a_text_region_may_be_intermediate_and_then_refined() {
    let symbols = symbols();
    let text = Text::new(24, 16);
    let instances = text_instances();
    let before = expected_text(&text, &symbols, &instances);
    let mut after = before.clone();
    after[3][2] ^= 1;
    after[9][5] ^= 1;
    let (coding, refer, at) = refinement_template(1);
    let mut stream = page(24, 16, 0);
    stream.extend(symbol_dictionary(1, &symbols));
    stream.extend(arithmetic_text(2, 4, &text, &symbols, &instances, &[1]));
    let data = refinement_body(region_info(24, 16, 0, 0, 4), 1, &at, encode_refinement(&after, &before, &coding, &refer));
    stream.extend(segment_with(3, 42, &[2], &data));
    assert_eq!(decoded(&stream, 24, 16), packed(&after));
}

// ---- Huffman coded text regions ----------------------------------------------------------------------------------------

type Line = (u32, u32, i32);

const B3: &[Line] = &[(8, 8, -256), (1, 0, 0), (2, 0, 1), (3, 0, 2), (4, 3, 3), (5, 6, 11), (8, 32, -257), (7, 32, 75), (6, 0, 0)];
const B5: &[Line] = &[(7, 8, -255), (1, 0, 1), (2, 0, 2), (3, 0, 3), (4, 3, 4), (5, 6, 12), (7, 32, -256), (6, 32, 76)];
const B7: &[Line] = &[
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
];
const B9: &[Line] = &[
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
];
const B10: &[Line] = &[
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
];
const B12: &[Line] = &[
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
];
const B13: &[Line] = &[
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
];
const B14: &[Line] = &[(3, 0, -2), (3, 0, -1), (1, 0, 0), (3, 0, 1), (3, 0, 2), (0, 32, -3), (0, 32, 3)];
const B15: &[Line] =
    &[(7, 4, -24), (6, 2, -8), (5, 1, -4), (4, 0, -2), (3, 0, -1), (1, 0, 0), (3, 0, 1), (4, 0, 2), (5, 1, 3), (6, 2, 5), (7, 4, 9), (7, 32, -25), (7, 32, 25)];

/// A table the coder uses: the selector value the segment carries, its lines (the ranges, the lower and upper range
/// and the out-of-band value if there is one) and, for a table of its own, the data of its table segment.
#[derive(Clone)]
struct Table {
    choice: u16,
    lines: Vec<Line>,
    oob: bool,
    segment: Option<Vec<u8>>,
}

fn standard(choice: u16, lines: &[Line], oob: bool) -> Table {
    Table { choice, lines: lines.to_vec(), oob, segment: None }
}

/// A table segment (B.2): the values -16 to 15 in two ranges of 16, a lower and an upper range beyond them, and the
/// out-of-band value if `oob`; the prefix lengths are 2 for the ranges and 3 for the others.
fn custom(choice: u16, oob: bool) -> Table {
    let mut lines = vec![(2, 4, -16), (2, 4, 0), (3, 32, -17), (3, 32, 16)];
    let mut bits = String::from("10100 10100 11 11");
    if oob {
        lines.push((3, 0, 0));
        bits.push_str(" 11");
    }
    let mut data = vec![u8::from(oob) | (1 << 1) | (2 << 4)];
    data.extend((-16i32).to_be_bytes());
    data.extend(16i32.to_be_bytes());
    data.extend(pack_bits(&bits));
    Table { choice, lines, oob, segment: Some(data) }
}

/// The code of `value` in a table: the prefix and the offset in its range, or the out-of-band code for `None`.
fn code(table: &Table, value: Option<i64>) -> String {
    let codes = prefix_codes(&table.lines);
    let count = table.lines.len();
    let Some(value) = value else {
        assert!(table.oob);
        return codes[count - 1].clone();
    };
    let plain = count - 2 - usize::from(table.oob);
    if let Some((i, line)) = table.lines[..plain].iter().enumerate().find(|(_, l)| l.0 > 0 && value >= i64::from(l.2) && value < i64::from(l.2) + (1i64 << l.1))
    {
        let offset = if line.1 == 0 { String::new() } else { format!("{:0w$b}", value - i64::from(line.2), w = line.1 as usize) };
        return format!("{}{offset}", codes[i]);
    }
    let (lower, upper) = (plain, plain + 1);
    if table.lines[upper].0 > 0 && value >= i64::from(table.lines[upper].2) {
        format!("{}{:032b}", codes[upper], value - i64::from(table.lines[upper].2))
    } else {
        assert!(table.lines[lower].0 > 0, "{value} is in no range");
        format!("{}{:032b}", codes[lower], i64::from(table.lines[lower].2) - value)
    }
}

/// The eight tables of a Huffman coded text region.
#[derive(Clone)]
struct Tables {
    fs: Table,
    ds: Table,
    dt: Table,
    rdw: Table,
    rdh: Table,
    rdx: Table,
    rdy: Table,
    rsize: Table,
}

impl Tables {
    /// Standard tables: `fs` 0 or 1 is B.6 or B.7, `ds` 0 to 2 is B.8 to B.10, `dt` 0 to 2 is B.11 to B.13, `rd` 0 or 1
    /// is B.14 or B.15 for the four size and position changes, and B.1 for the size of a refinement.
    fn standard(fs: u16, ds: u16, dt: u16, rd: u16) -> Self {
        let rd_lines = [B14, B15][rd as usize];
        Tables {
            fs: standard(fs, [B6, B7][fs as usize], false),
            ds: standard(ds, [B8, B9, B10][ds as usize], true),
            dt: standard(dt, [B11, B12, B13][dt as usize], false),
            rdw: standard(rd, rd_lines, false),
            rdh: standard(rd, rd_lines, false),
            rdx: standard(rd, rd_lines, false),
            rdy: standard(rd, rd_lines, false),
            rsize: standard(0, B1, false),
        }
    }

    /// Every table of the segments' own.
    fn custom() -> Self {
        Tables {
            fs: custom(3, false),
            ds: custom(3, true),
            dt: custom(3, false),
            rdw: custom(3, false),
            rdh: custom(3, false),
            rdx: custom(3, false),
            rdy: custom(3, false),
            rsize: custom(1, false),
        }
    }

    fn flags(&self) -> u16 {
        self.fs.choice
            | (self.ds.choice << 2)
            | (self.dt.choice << 4)
            | (self.rdw.choice << 6)
            | (self.rdh.choice << 8)
            | (self.rdx.choice << 10)
            | (self.rdy.choice << 12)
            | (self.rsize.choice << 14)
    }

    /// The table segments, in the order the selectors ask for them.
    fn segments(&self, first_number: u32) -> Vec<Vec<u8>> {
        [&self.fs, &self.ds, &self.dt, &self.rdw, &self.rdh, &self.rdx, &self.rdy, &self.rsize]
            .iter()
            .filter_map(|t| t.segment.clone())
            .enumerate()
            .map(|(k, data)| segment(first_number + k as u32, 53, &data))
            .collect()
    }
}

/// A segment that refers to any number of segments (more than four take the long form of the header, 7.2.4).
fn segment_many(number: u32, kind: u8, referred: &[u32], data: &[u8]) -> Vec<u8> {
    if referred.len() <= 4 {
        return segment_with(number, kind, referred, data);
    }
    let mut out = Vec::new();
    out.extend(be32(number));
    out.push(kind);
    out.extend((0xE000_0000u32 | referred.len() as u32).to_be_bytes());
    out.extend(vec![0u8; (referred.len() + 1).div_ceil(8)]);
    out.extend(referred.iter().map(|&n| n as u8));
    out.push(1);
    out.extend(be32(data.len() as u32));
    out.extend_from_slice(data);
    out
}

/// Bits and the bytes before them: arithmetic coded data (a refinement) is spliced in at a byte boundary.
#[derive(Default)]
struct BitOut {
    bytes: Vec<u8>,
    bits: String,
}

impl BitOut {
    fn put(&mut self, bits: &str) {
        self.bits.push_str(bits);
    }

    fn align(&mut self) {
        self.bytes.extend(pack_bits(&self.bits));
        self.bits.clear();
    }

    fn finish(mut self) -> Vec<u8> {
        self.align();
        self.bytes
    }
}

/// The symbol-ID table of a Huffman coded text region (7.4.3.1.7) for symbols with the given prefix lengths: each
/// length is a run code of its own with a prefix of the same size, so the lengths are sent one by one. Returns the bits
/// of the table (a whole number of bytes) and the code of each symbol.
fn symbol_id_table(lengths: &[u32]) -> (String, Vec<String>) {
    let mut used = lengths.to_vec();
    used.sort_unstable();
    used.dedup();
    let width = (used.len().next_power_of_two().trailing_zeros() as usize).max(1);
    let mut bits = String::new();
    for run_code in 0..35u32 {
        bits.push_str(&format!("{:04b}", if used.contains(&run_code) { width } else { 0 }));
    }
    for length in lengths {
        let k = used.iter().position(|u| u == length).unwrap();
        bits.push_str(&format!("{k:0width$b}"));
    }
    while bits.len() % 8 != 0 {
        bits.push('0');
    }
    let lines: Vec<Line> = lengths.iter().map(|&l| (l, 0, 0)).collect();
    (bits, prefix_codes(&lines))
}

/// The strips of a Huffman coded text region written to `out`: with `id_codes` the prefix codes of the symbols.
/// Refinements share `refinement` (one set of contexts for the whole region). The reference moves by half the change of
/// size (rounded down) plus the offset, in this mode as in the arithmetic one (T.88 6.4.11). Of the decoders in common use
/// one takes a quarter in Huffman text regions and the others a half, so the standard is followed.
fn huffman_strips(
    out: &mut BitOut,
    text: &Text,
    symbols: &[Vec<Vec<u8>>],
    instances: &[Instance],
    id_codes: &[String],
    tables: &Tables,
    refinement: &mut MqEncoder,
) {
    let template = refinement_template(text.r_template);
    let placed = by_strip(text, symbols, instances);
    out.put(&code(&tables.dt, Some(1)));
    let (mut current_strip, mut first_s) = (-1i64, 0i64);
    let mut k = 0;
    while k < placed.len() {
        let strip = placed[k].1.2.div_euclid(text.strips);
        let end = placed[k..].iter().position(|p| p.1.2.div_euclid(text.strips) != strip).map_or(placed.len(), |n| k + n);
        out.put(&code(&tables.dt, Some(strip - current_strip)));
        current_strip = strip;
        let mut cursor = 0;
        for (n, (instance, (coded, advance, t))) in placed[k..end].iter().enumerate() {
            if n == 0 {
                out.put(&code(&tables.fs, Some(coded - first_s)));
                first_s = *coded;
            } else {
                out.put(&code(&tables.ds, Some(coded - cursor - text.ds_offset)));
            }
            if text.strips != 1 {
                out.put(&format!("{:0w$b}", t - strip * text.strips, w = text.strips.trailing_zeros() as usize));
            }
            out.put(&id_codes[instance.id]);
            if text.refine {
                match &instance.refined {
                    None => out.put("0"),
                    Some(refined) => {
                        out.put("1");
                        let original = &symbols[instance.id];
                        let dw = refined.bitmap[0].len() as i64 - original[0].len() as i64;
                        let dh = refined.bitmap.len() as i64 - original.len() as i64;
                        for (table, value) in [(&tables.rdw, dw), (&tables.rdh, dh), (&tables.rdx, refined.rdx), (&tables.rdy, refined.rdy)] {
                            out.put(&code(table, Some(value)));
                        }
                        let shift = ((dw >> 1) + refined.rdx, (dh >> 1) + refined.rdy);
                        encode_shifted(refinement, 0, &refined.bitmap, original, shift, &template);
                        let data = refinement.terminate_jbig2();
                        out.put(&code(&tables.rsize, Some(data.len() as i64)));
                        out.align();
                        out.bytes.extend(data);
                    }
                }
            }
            cursor = *advance;
        }
        out.put(&code(&tables.ds, None));
        k = end;
    }
}

/// A Huffman coded text region segment (`kind` 4, 6 or 7); `referred` lists the dictionary and the table segments.
fn huffman_text(
    number: u32,
    kind: u8,
    text: &Text,
    symbols: &[Vec<Vec<u8>>],
    instances: &[Instance],
    lengths: &[u32],
    tables: &Tables,
    referred: &[u32],
) -> Vec<u8> {
    let (id_bits, id_codes) = symbol_id_table(lengths);
    let mut out = BitOut::default();
    out.put(&id_bits);
    let mut refinement = MqEncoder::new(1 << 13, &[]);
    huffman_strips(&mut out, text, symbols, instances, &id_codes, tables, &mut refinement);
    let mut data = text.head(Some(tables.flags()), instances.len());
    data.extend(out.finish());
    segment_many(number, kind, referred, &data)
}

/// A stream with the dictionary of `symbols` (segment 1), the tables' own segments (11 and up) and a Huffman coded text
/// region that refers to all of them.
fn huffman_text_stream(text: &Text, symbols: &[Vec<Vec<u8>>], instances: &[Instance], lengths: &[u32], tables: &Tables) -> Vec<u8> {
    let mut stream = page(text.width as u32, text.height as u32, 0);
    stream.extend(symbol_dictionary(1, symbols));
    let table_segments = tables.segments(11);
    let referred: Vec<u32> = std::iter::once(1).chain(11..11 + table_segments.len() as u32).collect();
    stream.extend(table_segments.concat());
    stream.extend(huffman_text(40, 6, text, symbols, instances, lengths, tables, &referred));
    stream
}

#[test]
fn a_huffman_text_region_selects_its_standard_tables_and_places_symbols_by_every_corner_and_strip_size() {
    let symbols = symbols();
    let cases = [
        // (tables fs, ds, dt, rd; strips, corner, transposed; symbol prefix lengths)
        ((1, 1, 1, 0), (1, 1, false), [1, 2, 2]),
        ((0, 2, 2, 1), (4, 3, true), [2, 1, 2]),
        ((1, 0, 0, 0), (2, 0, false), [2, 2, 2]),
        ((0, 1, 2, 1), (8, 2, true), [1, 3, 3]),
    ];
    for ((fs, ds, dt, rd), (strips, corner, transposed), lengths) in cases {
        let text = Text { strips, corner, transposed, ds_offset: -2, ..Text::new(24, 16) };
        let instances = text_instances();
        let stream = huffman_text_stream(&text, &symbols, &instances, &lengths, &Tables::standard(fs, ds, dt, rd));
        let expected = expected_text(&text, &symbols, &instances);
        assert_eq!(decoded(&stream, 24, 16), packed(&expected), "tables {fs}{ds}{dt}{rd}, strips {strips}, corner {corner}");
    }
}

#[test]
fn a_huffman_text_region_may_refine_symbols_with_either_template() {
    let symbols = symbols();
    let mut instances = refined_instances(&symbols);
    // A size change of two makes the shift of the reference differ between the coding modes.
    instances[2].refined = Some(Refined { bitmap: rows(&["1111001", "1001011", "1001101", "1111001"]), rdx: 0, rdy: 0 });
    for (r_template, rd) in [(0u8, 0u16), (1, 1)] {
        let text = Text { refine: true, r_template, ..Text::new(24, 16) };
        let stream = huffman_text_stream(&text, &symbols, &instances, &[1, 2, 2], &Tables::standard(0, 0, 0, rd));
        let expected = expected_text(&text, &symbols, &instances);
        assert_eq!(decoded(&stream, 24, 16), packed(&expected), "template {r_template}");
    }
}

#[test]
fn a_huffman_text_region_may_take_every_table_from_table_segments() {
    let symbols = symbols();
    // The first position of the first strip is past 15 (the upper range) and the step back in it is below -16 (the
    // lower range): both are coded with 32 offset bits.
    let mut instances = vec![at(0, 20, 1), at(1, 1, 1)];
    instances.extend([at(2, 2, 7), at(0, 9, 7), at(1, 14, 8)]);
    let mut refined = refined_instances(&symbols);
    refined.push(at(0, 20, 1));
    for (list, refine) in [(&instances, false), (&refined, true)] {
        let text = Text { refine, ..Text::new(24, 16) };
        let stream = huffman_text_stream(&text, &symbols, list, &[1, 2, 2], &Tables::custom());
        let expected = expected_text(&text, &symbols, list);
        assert_eq!(decoded(&stream, 24, 16), packed(&expected), "refine {refine}");
    }
}

// ---- symbol dictionaries ----------------------------------------------------------------------------------------------

/// Runs of (not exported, exported, ...) over the export flags (6.5.10), the first possibly of length 0.
fn export_runs(flags: &[bool]) -> Vec<i64> {
    let (mut runs, mut current, mut count) = (Vec::new(), false, 0);
    for &flag in flags {
        if flag == current {
            count += 1;
        } else {
            runs.push(count);
            current = flag;
            count = 1;
        }
    }
    runs.push(count);
    runs
}

struct Dict<'a> {
    number: u32,
    template: u8,
    /// Keep the contexts for a later dictionary (bit 9) / start from the contexts of the dictionary referred to (bit 8).
    retain: bool,
    reuse: bool,
    referred: &'a [u32],
    inputs: usize,
    new: &'a [Vec<Vec<u8>>],
    exports: &'a [bool],
}

/// An arithmetic coded dictionary of new symbols (in order of height), and the states its bitmap contexts end in.
fn arithmetic_dictionary(d: &Dict, contexts: Option<&[(usize, u8)]>) -> (Vec<u8>, Vec<(usize, u8)>) {
    let (offsets, at) = template(d.template);
    let count = 1usize << offsets.len();
    let (heights, widths, exports) = (GENERIC_CONTEXTS, GENERIC_CONTEXTS + 512, GENERIC_CONTEXTS + 1024);
    let mut coder = MqEncoder::new(GENERIC_CONTEXTS + 1536, &[]);
    if let Some(states) = contexts {
        coder.load_states(0, states);
    }
    let (mut class_height, mut index) = (0i64, 0);
    while index < d.new.len() {
        let height = d.new[index].len() as i64;
        encode_integer(&mut coder, heights, Some(height - class_height));
        class_height = height;
        let mut width = 0i64;
        while index < d.new.len() && d.new[index].len() as i64 == height {
            let symbol = &d.new[index];
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
    for run in export_runs(d.exports) {
        encode_integer(&mut coder, exports, Some(run));
    }
    let states = coder.states()[..count].to_vec();
    let flags = (u16::from(d.template) << 10) | (u16::from(d.reuse) << 8) | (u16::from(d.retain) << 9);
    let mut data = flags.to_be_bytes().to_vec();
    data.extend(at);
    data.extend(be32(d.exports.iter().filter(|&&e| e).count() as u32));
    data.extend(be32(d.new.len() as u32));
    data.extend(coder.finish(true));
    let _ = d.inputs;
    (segment_many(d.number, 0, d.referred, &data), states)
}

#[test]
fn dictionaries_of_every_template_continue_each_others_contexts_and_export_what_the_flags_choose() {
    let symbols = symbols();
    for template in 0..4u8 {
        let first = Dict { number: 1, template, retain: true, reuse: false, referred: &[], inputs: 0, new: &symbols[..2], exports: &[true, true] };
        let (first_segment, states) = arithmetic_dictionary(&first, None);
        // The second dictionary has the first's two symbols as input, one new symbol, and exports the second input
        // symbol and the new one.
        let second = Dict { number: 2, template, retain: false, reuse: true, referred: &[1], inputs: 2, new: &symbols[2..], exports: &[false, true, true] };
        let (second_segment, _) = arithmetic_dictionary(&second, Some(&states));
        // A text region that refers to both takes the first's two symbols and then the second's two.
        let list = vec![symbols[0].clone(), symbols[1].clone(), symbols[1].clone(), symbols[2].clone()];
        let instances = vec![at(0, 1, 1), at(2, 7, 1), at(3, 2, 7), at(1, 9, 7), at(1, 14, 8)];
        let text = Text::new(24, 16);
        let mut stream = page(24, 16, 0);
        stream.extend(first_segment);
        stream.extend(second_segment);
        stream.extend(arithmetic_text(3, 6, &text, &list, &instances, &[1, 2]));
        assert_eq!(decoded(&stream, 24, 16), packed(&expected_text(&text, &list, &instances)), "template {template}");
    }
}

/// A new symbol of a dictionary with refinement and aggregation: a refinement of a known symbol, or an aggregate of
/// known symbols drawn at the given positions on a blank bitmap.
enum New {
    Refine { from: usize, bitmap: Vec<Vec<u8>> },
    Aggregate { parts: Vec<(usize, i64)>, width: usize, height: usize },
}

fn new_bitmap(new: &New, known: &[Vec<Vec<u8>>]) -> Vec<Vec<u8>> {
    match new {
        New::Refine { bitmap, .. } => bitmap.clone(),
        New::Aggregate { parts, width, height } => {
            let mut canvas = vec![vec![0u8; *width]; *height];
            for &(id, x) in parts {
                compose(&mut canvas, &known[id], x, 0, 0);
            }
            canvas
        }
    }
}

struct Refagg<'a> {
    number: u32,
    huffman: bool,
    r_template: u8,
    referred: &'a [u32],
    inputs: &'a [Vec<Vec<u8>>],
    new: &'a [New],
    exports: &'a [bool],
    reuse: bool,
    retain: bool,
    /// A table of its own for the instance counts (Huffman coding).
    agg: Option<&'a Table>,
}

/// A dictionary of refined and aggregated symbols (6.5.8.2) in either coding mode: the segment, the states of the
/// refinement contexts at its end, and the symbols it exports.
fn refagg_dictionary(d: &Refagg, contexts: Option<&[(usize, u8)]>) -> (Vec<u8>, Vec<(usize, u8)>, Vec<Vec<Vec<u8>>>) {
    let total = d.inputs.len() + d.new.len();
    let template = refinement_template(d.r_template);
    let mut known: Vec<Vec<Vec<u8>>> = d.inputs.to_vec();
    let mut heights_of = Vec::new();
    for new in d.new {
        let bitmap = new_bitmap(new, &known);
        heights_of.push(bitmap.len());
        known.push(bitmap);
    }
    let exported: Vec<Vec<Vec<u8>>> = known.iter().zip(d.exports).filter(|(_, e)| **e).map(|(s, _)| s.clone()).collect();
    let mut data = Vec::new();
    let flags = 0x2u16
        | (u16::from(d.huffman))
        | (u16::from(d.agg.is_some()) << 7)
        | (u16::from(d.r_template) << 12)
        | (u16::from(d.reuse) << 8)
        | (u16::from(d.retain) << 9);
    data.extend(flags.to_be_bytes());
    if !d.huffman {
        data.extend(template_at_default());
    }
    if d.r_template == 0 {
        data.extend(refinement_template(0).2);
    }
    data.extend(be32(exported.len() as u32));
    data.extend(be32(d.new.len() as u32));
    let states;
    if d.huffman {
        let code_len = (1..).find(|&n| (1usize << n) >= total).unwrap();
        let id_codes: Vec<String> = (0..total).map(|id| format!("{id:0code_len$b}")).collect();
        let (b4, b2, b1, b15) = (standard(0, B4, false), standard(0, B2, true), standard(0, B1, false), standard(1, B15, false));
        let tables = Tables::standard(0, 0, 0, 1);
        let counts = d.agg.cloned().unwrap_or_else(|| standard(0, B1, false));
        let mut out = BitOut::default();
        let mut refinement = MqEncoder::new(1 << 13, &[]);
        let (mut class_height, mut index) = (0usize, 0);
        while index < d.new.len() {
            let height = heights_of[index];
            out.put(&code(&b4, Some((height - class_height) as i64)));
            class_height = height;
            let mut width = 0i64;
            while index < d.new.len() && heights_of[index] == height {
                let bitmap = &known[d.inputs.len() + index];
                out.put(&code(&b2, Some(bitmap[0].len() as i64 - width)));
                width = bitmap[0].len() as i64;
                match &d.new[index] {
                    New::Refine { from, bitmap } => {
                        out.put(&code(&counts, Some(1)));
                        out.put(&id_codes[*from]);
                        out.put(&code(&b15, Some(0)));
                        out.put(&code(&b15, Some(0)));
                        encode_shifted(&mut refinement, 0, bitmap, &known[*from], (0, 0), &template);
                        let bytes = refinement.terminate_jbig2();
                        out.put(&code(&b1, Some(bytes.len() as i64)));
                        out.align();
                        out.bytes.extend(bytes);
                    }
                    New::Aggregate { parts, width, height } => {
                        out.put(&code(&counts, Some(parts.len() as i64)));
                        let text = Text { refine: true, r_template: d.r_template, ..Text::new(*width, *height) };
                        let instances: Vec<Instance> = parts.iter().map(|&(id, x)| at(id, x, 0)).collect();
                        let seen = &known[..d.inputs.len() + index];
                        huffman_strips(&mut out, &text, seen, &instances, &id_codes, &tables, &mut refinement);
                    }
                }
                index += 1;
            }
            out.put(&code(&b2, None));
        }
        for run in export_runs(d.exports) {
            out.put(&code(&b1, Some(run)));
        }
        data.extend(out.finish());
        states = Vec::new();
    } else {
        let bits = code_length(total);
        let [heights, widths, exports, counts, time, first, delta, flag, rdw, rdh, rdx, rdy] =
            [0usize, 512, 1024, 1536, 2048, 2560, 3072, 4096, 4608, 5120, 5632, 6144];
        let ids = 6656usize;
        let refinement = ids + (2usize << bits);
        let size = 1usize << template.0.len() + template.1.len();
        let mut coder = MqEncoder::new(refinement + size, &[]);
        if let Some(states) = contexts {
            coder.load_states(refinement, states);
        }
        let (mut class_height, mut index) = (0usize, 0);
        while index < d.new.len() {
            let height = heights_of[index];
            encode_integer(&mut coder, heights, Some((height - class_height) as i64));
            class_height = height;
            let mut width = 0i64;
            while index < d.new.len() && heights_of[index] == height {
                let bitmap = &known[d.inputs.len() + index];
                encode_integer(&mut coder, widths, Some(bitmap[0].len() as i64 - width));
                width = bitmap[0].len() as i64;
                match &d.new[index] {
                    New::Refine { from, bitmap } => {
                        encode_integer(&mut coder, counts, Some(1));
                        iaid(&mut coder, ids, bits, *from);
                        encode_integer(&mut coder, rdx, Some(0));
                        encode_integer(&mut coder, rdy, Some(0));
                        encode_shifted(&mut coder, refinement, bitmap, &known[*from], (0, 0), &template);
                    }
                    New::Aggregate { parts, .. } => {
                        encode_integer(&mut coder, counts, Some(parts.len() as i64));
                        encode_integer(&mut coder, time, Some(0));
                        encode_integer(&mut coder, time, Some(0));
                        let mut cursor = 0;
                        for (k, &(id, x)) in parts.iter().enumerate() {
                            if k == 0 {
                                encode_integer(&mut coder, first, Some(x));
                            } else {
                                encode_integer(&mut coder, delta, Some(x - cursor));
                            }
                            iaid(&mut coder, ids, bits, id);
                            encode_integer(&mut coder, flag, Some(0));
                            cursor = x + known[id][0].len() as i64 - 1;
                        }
                        encode_integer(&mut coder, delta, None);
                    }
                }
                index += 1;
            }
            encode_integer(&mut coder, widths, None);
        }
        let _ = (rdw, rdh);
        for run in export_runs(d.exports) {
            encode_integer(&mut coder, exports, Some(run));
        }
        states = coder.states()[refinement..].to_vec();
        data.extend(coder.finish(true));
    }
    (segment_many(d.number, 0, d.referred, &data), states, exported)
}

/// The default adaptive pixels of generic template 0, as the bytes a segment carries.
fn template_at_default() -> Vec<u8> {
    template(0).1
}

#[test]
fn dictionaries_that_refine_and_aggregate_work_in_both_coding_modes_and_with_both_refinement_templates() {
    let input = symbols();
    let refined = rows(&["11111", "11001", "10011", "11111"]);
    let new = [New::Refine { from: 1, bitmap: refined.clone() }, New::Aggregate { parts: vec![(0, 0), (2, 3)], width: 7, height: 6 }];
    let exports = [false, false, false, true, true];
    for huffman in [false, true] {
        for r_template in 0..2u8 {
            let d =
                Refagg { number: 2, huffman, r_template, referred: &[1], inputs: &input, new: &new, exports: &exports, reuse: false, retain: false, agg: None };
            let (segment, _, exported) = refagg_dictionary(&d, None);
            let text = Text::new(16, 12);
            let placed = vec![at(0, 1, 0), at(1, 8, 0)];
            let mut stream = page(16, 12, 0);
            stream.extend(symbol_dictionary(1, &input));
            stream.extend(segment);
            stream.extend(arithmetic_text(3, 6, &text, &exported, &placed, &[2]));
            assert_eq!(decoded(&stream, 16, 12), packed(&expected_text(&text, &exported, &placed)), "huffman {huffman}, template {r_template}");
        }
    }
}

#[test]
fn a_refining_dictionary_may_continue_the_refinement_contexts_of_the_one_it_refers_to() {
    let input = symbols();
    let first_new =
        [New::Refine { from: 1, bitmap: rows(&["11111", "11001", "10011", "11111"]) }, New::Aggregate { parts: vec![(0, 0), (2, 3)], width: 7, height: 6 }];
    let first = Refagg {
        number: 2,
        huffman: false,
        r_template: 1,
        referred: &[1],
        inputs: &input,
        new: &first_new,
        exports: &[false, false, false, true, true],
        reuse: false,
        retain: true,
        agg: None,
    };
    let (first_segment, states, exported) = refagg_dictionary(&first, None);
    // The second dictionary refines the first's first symbol and exports it with the first's second.
    let second_new = [New::Refine { from: 0, bitmap: rows(&["11111", "10001", "10101", "11111"]) }];
    let second = Refagg {
        number: 3,
        huffman: false,
        r_template: 1,
        referred: &[2],
        inputs: &exported,
        new: &second_new,
        exports: &[false, true, true],
        reuse: true,
        retain: false,
        agg: None,
    };
    let (second_segment, _, exported_again) = refagg_dictionary(&second, Some(&states));
    let text = Text::new(16, 12);
    let placed = vec![at(0, 1, 0), at(1, 8, 0)];
    let mut stream = page(16, 12, 0);
    stream.extend(symbol_dictionary(1, &input));
    stream.extend(first_segment);
    stream.extend(second_segment);
    stream.extend(arithmetic_text(4, 6, &text, &exported_again, &placed, &[3]));
    assert_eq!(decoded(&stream, 16, 12), packed(&expected_text(&text, &exported_again, &placed)));
}

// ---- Huffman coded dictionaries with their own tables and MMR bitmaps ----------------------------------------------

/// A Huffman coded dictionary (6.5) whose collective bitmaps are uncompressed (size 0) or MMR coded.
fn huffman_dictionary(number: u32, symbols: &[Vec<Vec<u8>>], mmr: bool, dh: &Table, dw: &Table, bm: &Table, referred: &[u32]) -> Vec<u8> {
    let b1 = standard(0, B1, false);
    let mut out = BitOut::default();
    let (mut class_height, mut index) = (0i64, 0);
    while index < symbols.len() {
        let height = symbols[index].len() as i64;
        out.put(&code(dh, Some(height - class_height)));
        class_height = height;
        let first = index;
        let mut width = 0i64;
        while index < symbols.len() && symbols[index].len() as i64 == height {
            let w = symbols[index][0].len() as i64;
            out.put(&code(dw, Some(w - width)));
            width = w;
            index += 1;
        }
        out.put(&code(dw, None));
        let collective: Vec<Vec<u8>> = (0..height as usize).map(|y| symbols[first..index].iter().flat_map(|s| s[y].clone()).collect()).collect();
        if mmr {
            // The bitmap of a dictionary has no end-of-block code (6.2.6); its size is in the segment.
            let coded = t6(&collective);
            let bytes = pack_bits(&coded[..coded.len() - 24]);
            out.put(&code(bm, Some(bytes.len() as i64)));
            out.align();
            out.bytes.extend(bytes);
        } else {
            out.put(&code(bm, Some(0)));
            out.align();
            for row in &collective {
                out.put(&row.iter().map(|&p| char::from(b'0' + p)).collect::<String>());
                out.align();
            }
        }
    }
    out.put(&code(&b1, Some(0)));
    out.put(&code(&b1, Some(symbols.len() as i64)));
    let flags = 1u16 | (dh.choice << 2) | (dw.choice << 4) | (bm.choice << 6);
    let mut data = flags.to_be_bytes().to_vec();
    data.extend(be32(symbols.len() as u32));
    data.extend(be32(symbols.len() as u32));
    data.extend(out.finish());
    segment_many(number, 0, referred, &data)
}

#[test]
fn a_huffman_dictionary_selects_its_tables_and_may_code_the_collective_bitmaps_as_mmr() {
    let symbols = symbols();
    let cases: Vec<(&str, [Table; 3], bool)> = vec![
        ("B.4 B.2 B.1", [standard(0, B4, false), standard(0, B2, true), standard(0, B1, false)], false),
        ("B.5 B.3 B.1 MMR", [standard(1, B5, false), standard(1, B3, true), standard(0, B1, false)], true),
        ("own tables MMR", [custom(3, false), custom(3, true), custom(1, false)], true),
        ("own tables", [custom(3, false), custom(3, true), custom(1, false)], false),
    ];
    for (name, [dh, dw, bm], mmr) in cases {
        let tables: Vec<Vec<u8>> = [&dh, &dw, &bm].iter().filter_map(|t| t.segment.clone()).enumerate().map(|(k, d)| segment(11 + k as u32, 53, &d)).collect();
        let referred: Vec<u32> = (11..11 + tables.len() as u32).collect();
        let mut stream = page(24, 16, 0);
        stream.extend(tables.concat());
        stream.extend(huffman_dictionary(30, &symbols, mmr, &dh, &dw, &bm, &referred));
        let text = Text::new(24, 16);
        let instances = text_instances();
        stream.extend(arithmetic_text(31, 6, &text, &symbols, &instances, &[30]));
        let out = jbig2::decode(&stream, 24, 16, None).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(out, packed(&expected_text(&text, &symbols, &instances)), "{name}");
    }
}

// ---- pattern dictionaries and halftone regions ------------------------------------------------------------------------

fn patterns() -> Vec<Vec<Vec<u8>>> {
    vec![
        rows(&["0000", "0000", "0000", "0000"]),
        rows(&["1000", "0100", "0010", "0001"]),
        rows(&["1100", "1100", "0011", "0011"]),
        rows(&["1111", "1111", "1111", "1111"]),
    ]
}

/// A pattern dictionary segment (type 16): the patterns side by side as one bitmap, arithmetic coded as a generic
/// region of `template` whose first adaptive pixel is one pattern width to the left, or MMR coded.
fn pattern_dictionary(number: u32, patterns: &[Vec<Vec<u8>>], template_number: u8, mmr: bool) -> Vec<u8> {
    let width = patterns[0][0].len();
    let collective: Vec<Vec<u8>> = (0..patterns[0].len()).map(|y| patterns.iter().flat_map(|p| p[y].clone()).collect()).collect();
    let mut data = vec![u8::from(mmr) | (template_number << 1), width as u8, patterns[0].len() as u8];
    data.extend(be32(patterns.len() as u32 - 1));
    if mmr {
        data.extend(pack_bits(&t6(&collective)));
    } else {
        let (mut offsets, _) = template(template_number);
        // The adaptive pixel that moves is the first: (3, -1) in templates 0 and 1, (2, -1) in the others.
        let slot = match template_number {
            0 => 11,
            1 => 9,
            2 => 7,
            _ => 5,
        };
        offsets[slot] = (-(width as i32), 0);
        data.extend(encode_generic(&collective, &offsets));
    }
    segment(number, 16, &data)
}

struct Halftone {
    width: usize,
    height: usize,
    template: u8,
    mmr: bool,
    skip: bool,
    op: u8,
    def_pixel: u8,
    /// The gray value of each cell, row by row.
    grid: Vec<Vec<usize>>,
    grid_x: i32,
    grid_y: i32,
    step_x: u16,
    step_y: u16,
}

impl Halftone {
    fn new(width: usize, height: usize, grid: Vec<Vec<usize>>) -> Self {
        Halftone { width, height, template: 0, mmr: false, skip: false, op: 0, def_pixel: 0, grid, grid_x: 0, grid_y: 0, step_x: 4 << 8, step_y: 0 }
    }

    /// Where cell (m, n) goes (6.6.5.2).
    fn cell(&self, m: usize, n: usize) -> (i64, i64) {
        let (m, n) = (m as i64, n as i64);
        (
            (i64::from(self.grid_x) + m * i64::from(self.step_y) + n * i64::from(self.step_x)) >> 8,
            (i64::from(self.grid_y) + m * i64::from(self.step_x) - n * i64::from(self.step_y)) >> 8,
        )
    }

    fn skipped(&self, m: usize, n: usize, pattern: &[Vec<u8>]) -> bool {
        let (x, y) = self.cell(m, n);
        x + pattern[0].len() as i64 <= 0 || x >= self.width as i64 || y + pattern.len() as i64 <= 0 || y >= self.height as i64
    }

    fn expected(&self, patterns: &[Vec<Vec<u8>>]) -> Vec<Vec<u8>> {
        let mut canvas = vec![vec![self.def_pixel; self.width]; self.height];
        for (m, row) in self.grid.iter().enumerate() {
            for (n, &gray) in row.iter().enumerate() {
                let (x, y) = self.cell(m, n);
                compose(&mut canvas, &patterns[gray.min(patterns.len() - 1)], x, y, self.op);
            }
        }
        canvas
    }

    /// The halftone region segment of `kind` (20, 22 or 23) over the patterns of segment `dictionary`.
    fn segment(&self, number: u32, kind: u8, patterns: &[Vec<Vec<u8>>], dictionary: u32) -> Vec<u8> {
        let bits = (1..).find(|&b| (1usize << b) >= patterns.len()).unwrap();
        let (grid_height, grid_width) = (self.grid.len(), self.grid[0].len());
        // The bit planes, the most significant first, each exclusive-or'd with the one above it (Annex C.5); a skipped
        // cell is 0 in every plane.
        let planes: Vec<Vec<Vec<u8>>> = (0..bits)
            .map(|k| {
                (0..grid_height)
                    .map(|m| {
                        (0..grid_width)
                            .map(|n| {
                                let gray = self.grid[m][n];
                                let bit = |k: usize| ((gray >> (bits - 1 - k)) & 1) as u8;
                                if k == 0 { bit(0) } else { bit(k) ^ bit(k - 1) }
                            })
                            .collect()
                    })
                    .collect()
            })
            .collect();
        let coded = if self.mmr {
            planes.iter().flat_map(|plane| pack_bits(&t6(plane))).collect()
        } else {
            let (offsets, _) = template(self.template);
            let mut coder = MqEncoder::new(1 << offsets.len(), &[]);
            for plane in &planes {
                for m in 0..grid_height {
                    for n in 0..grid_width {
                        if self.skip && self.skipped(m, n, &patterns[0]) {
                            continue;
                        }
                        let context = offsets.iter().enumerate().fold(0, |acc, (k, (dx, dy))| acc | (pixel(plane, n as i32 + dx, m as i32 + dy) << k));
                        coder.encode(context, plane[m][n]);
                    }
                }
            }
            coder.finish(true)
        };
        let mut data = region_info(self.width, self.height, 0, 0, 0);
        data.push(u8::from(self.mmr) | (self.template << 1) | (u8::from(self.skip) << 3) | (self.op << 4) | (self.def_pixel << 7));
        data.extend(be32(grid_width as u32));
        data.extend(be32(grid_height as u32));
        data.extend((self.grid_x as u32).to_be_bytes());
        data.extend((self.grid_y as u32).to_be_bytes());
        data.extend(self.step_x.to_be_bytes());
        data.extend(self.step_y.to_be_bytes());
        data.extend(coded);
        segment_with(number, kind, &[dictionary], &data)
    }
}

fn halftone_stream(h: &Halftone, patterns: &[Vec<Vec<u8>>], dictionary_template: u8, kind: u8) -> Vec<u8> {
    let mut stream = page(h.width as u32, h.height as u32, 0);
    stream.extend(pattern_dictionary(1, patterns, dictionary_template, h.mmr));
    stream.extend(h.segment(2, kind, patterns, 1));
    stream
}

#[test]
fn halftone_regions_of_every_template_and_of_mmr_draw_the_pattern_of_each_gray_value() {
    let patterns = patterns();
    let grid = vec![vec![0, 1, 2], vec![3, 2, 1]];
    for template in 0..4u8 {
        let h = Halftone { template, ..Halftone::new(12, 8, grid.clone()) };
        let stream = halftone_stream(&h, &patterns, template, 22);
        assert_eq!(decoded(&stream, 12, 8), packed(&h.expected(&patterns)), "template {template}");
    }
    let h = Halftone { mmr: true, ..Halftone::new(12, 8, grid.clone()) };
    for kind in [22, 23] {
        assert_eq!(decoded(&halftone_stream(&h, &patterns, 0, kind), 12, 8), packed(&h.expected(&patterns)), "mmr, type {kind}");
    }
}

#[test]
fn a_halftone_grid_may_be_skewed_skip_cells_outside_the_region_and_combine_with_any_operator() {
    let patterns = patterns();
    // Cells at (2 + m + 4n, 2 + 4m - n): the grid is turned a little. In a 10 x 8 region the cells (m 0, n 2) at (10, 0)
    // and (m 1, n 2) at (11, 4) lie wholly outside and are not coded; their gray value is 0.
    let grid = vec![vec![1, 2, 0], vec![3, 1, 0]];
    for skip in [false, true] {
        for (op, def_pixel) in [(0u8, 0u8), (1, 1), (2, 0), (3, 1), (4, 1)] {
            let h = Halftone {
                skip,
                op,
                def_pixel,
                template: 1,
                grid_x: 2 << 8,
                grid_y: 2 << 8,
                step_x: 4 << 8,
                step_y: 1 << 8,
                ..Halftone::new(10, 8, grid.clone())
            };
            assert!(h.skipped(0, 2, &patterns[0]) && h.skipped(1, 2, &patterns[0]) && !h.skipped(1, 1, &patterns[0]));
            let stream = halftone_stream(&h, &patterns, 1, 22);
            // The unused bits at the end of a row hold the page's default pixel, here white.
            let padded: Vec<Vec<u8>> = h.expected(&patterns).iter().map(|row| [row.clone(), vec![0u8; 6]].concat()).collect();
            assert_eq!(decoded(&stream, 10, 8), packed(&padded), "skip {skip}, operator {op}, default {def_pixel}");
        }
    }
}

#[test]
fn a_gray_value_past_the_last_pattern_takes_the_last_pattern() {
    let patterns = patterns();
    // Three patterns need two bit planes, which can say 3.
    let h = Halftone::new(12, 8, vec![vec![3, 1, 2], vec![0, 3, 3]]);
    let three = &patterns[..3];
    let stream = halftone_stream(&h, three, 0, 22);
    assert_eq!(decoded(&stream, 12, 8), packed(&h.expected(three)));
    assert_eq!(h.expected(three)[0][..4], three[2][0][..]);
}

#[test]
fn a_halftone_region_may_be_intermediate_and_then_refined() {
    let patterns = patterns();
    let h = Halftone::new(12, 8, vec![vec![0, 1, 2], vec![3, 2, 1]]);
    let before = h.expected(&patterns);
    let mut after = before.clone();
    after[1][1] ^= 1;
    after[6][9] ^= 1;
    let (coding, refer, at) = refinement_template(0);
    let mut stream = page(12, 8, 0);
    stream.extend(pattern_dictionary(1, &patterns, 0, false));
    stream.extend(h.segment(2, 20, &patterns, 1));
    let data = refinement_body(region_info(12, 8, 0, 0, 4), 0, &at, encode_refinement(&after, &before, &coding, &refer));
    stream.extend(segment_with(3, 42, &[2], &data));
    assert_eq!(decoded(&stream, 12, 8), packed(&after));
}

// ---- globals, stripes and the end segments ----------------------------------------------------------------------------

#[test]
fn dictionaries_and_patterns_may_come_from_the_globals_stream() {
    let symbols = symbols();
    let patterns = patterns();
    let mut globals = symbol_dictionary(1, &symbols);
    globals.extend(pattern_dictionary(2, &patterns, 0, false));
    let text = Text::new(24, 16);
    let instances = text_instances();
    let h = Halftone::new(12, 8, vec![vec![0, 1, 2], vec![3, 2, 1]]);
    let mut stream = page(24, 16, 0);
    stream.extend(arithmetic_text(3, 6, &text, &symbols, &instances, &[1]));
    let mut region = h.segment(4, 22, &patterns, 2);
    // The halftone region goes to the right of the text: its x position is the third number of its region information,
    // after the 12 bytes of the segment header and two numbers.
    let at_x = 12 + 8;
    region[at_x..at_x + 4].copy_from_slice(&be32(12));
    stream.extend(region);
    let mut expected = expected_text(&text, &symbols, &instances);
    compose(&mut expected, &h.expected(&patterns), 12, 0, 0);
    let out = jbig2::decode(&stream, 24, 16, Some(&globals)).expect("decodes");
    assert_eq!(out, packed(&expected));
}

#[test]
fn stripes_extensions_and_the_end_of_page_leave_the_regions_alone() {
    let black = bitmap();
    let (offsets, at) = template(0);
    let top: Vec<Vec<u8>> = black[..3].to_vec();
    let bottom: Vec<Vec<u8>> = black[3..].to_vec();
    // Page information of unknown height with stripes of at most 16 rows.
    let mut info = Vec::new();
    info.extend(be32(16));
    info.extend(be32(u32::MAX));
    info.extend([0; 8]);
    info.push(0);
    info.extend(0x8010u16.to_be_bytes());
    let mut stream = segment(0, 48, &info);
    stream.extend(segment(1, 38, &generic_body(16, 3, 0, 0, 0, 0, &at, &encode_generic(&top, &offsets))));
    stream.extend(segment(2, 50, &be32(2))); // the end of the first stripe
    stream.extend(segment(3, 62, &[1, 2, 3, 4, 5])); // an extension
    stream.extend(segment(4, 52, &[0, 0, 0, 0])); // profiles
    stream.extend(segment(5, 38, &generic_body(16, 3, 0, 3, 0, 0, &at, &encode_generic(&bottom, &offsets))));
    stream.extend(segment(6, 50, &be32(5)));
    stream.extend(segment(7, 49, &[])); // the end of the page: what follows is not read
    stream.extend(segment(8, 38, &generic_body(16, 6, 0, 0, 2, 0, &at, &encode_generic(&black, &offsets))));
    assert_eq!(decoded(&stream, 16, 6), packed(&black));
    // The end of the file stops the stream the same way.
    let mut stream = segment(0, 48, &info);
    stream.extend(segment(1, 38, &generic_body(16, 3, 0, 0, 0, 0, &at, &encode_generic(&top, &offsets))));
    stream.extend(segment(2, 51, &[]));
    stream.extend(segment(3, 38, &generic_body(16, 3, 0, 3, 0, 0, &at, &encode_generic(&bottom, &offsets))));
    let mut expected = black.clone();
    expected[3..].iter_mut().for_each(|row| row.fill(0));
    assert_eq!(decoded(&stream, 16, 6), packed(&expected));
}

#[test]
fn streams_that_break_the_rules_of_the_standard_are_refused() {
    let symbols = symbols();
    let text = Text::new(24, 16);
    let instances = text_instances();
    let base = |extra: Vec<u8>| {
        let mut stream = page(24, 16, 0);
        stream.extend(extra);
        stream
    };
    let refused = |name: &str, stream: Vec<u8>| assert!(jbig2::decode(&stream, 24, 16, None).is_err(), "{name}");
    // A segment may refer only to earlier segments, and to segments that exist.
    refused("a text region that refers to a segment that is not there", base(arithmetic_text(5, 6, &text, &symbols, &instances, &[4])));
    refused("a segment that refers to itself", base([symbol_dictionary(1, &symbols), arithmetic_text(2, 6, &text, &symbols, &instances, &[2])].concat()));
    // At most 64 segments may be referred to.
    let many: Vec<u32> = (1..=65).collect();
    refused("65 referred segments", base(segment_many(100, 6, &many, &[0; 40])));
    // A halftone region refers to exactly one pattern dictionary; a refinement region to a region.
    let patterns = patterns();
    let h = Halftone::new(12, 8, vec![vec![0, 1, 2], vec![3, 2, 1]]);
    refused("a halftone region that refers to a symbol dictionary", base([symbol_dictionary(1, &symbols), h.segment(2, 22, &patterns, 1)].concat()));
    let body = h.segment(3, 22, &patterns, 2)[12..].to_vec();
    refused("a halftone region that refers to nothing", base([pattern_dictionary(2, &patterns, 0, false), segment(3, 22, &body)].concat()));
    let data = refinement_body(region_info(4, 4, 0, 0, 4), 1, &[], vec![0; 8]);
    refused("a refinement region that refers to a symbol dictionary", base([symbol_dictionary(1, &symbols), segment_with(2, 42, &[1], &data)].concat()));
    // Sizes past what the decoder allocates, counts past the limits.
    refused("a generic region of 100000 x 100000", base(segment(1, 38, &generic_body(100_000, 100_000, 0, 0, 0, 0, &template(0).1, &[0; 8]))));
    let mut huge = vec![0u8, 0];
    huge.extend(template(0).1);
    huge.extend(be32(0));
    huge.extend(be32(1 << 21));
    refused("a symbol dictionary of 2^21 symbols", base(segment(1, 0, &huge)));
    let mut table = vec![0u8];
    table.extend(5i32.to_be_bytes());
    table.extend(2i32.to_be_bytes());
    refused("a table whose lowest value is above its highest", base(segment(1, 53, &table)));
    let mut dictionary = vec![0u8, 4, 4];
    dictionary.extend(be32(70_000));
    refused("a pattern dictionary of 70001 patterns", base(segment(1, 16, &dictionary)));
}

#[test]
fn a_refining_huffman_dictionary_may_count_its_instances_with_a_table_of_its_own() {
    let input = symbols();
    let new =
        [New::Refine { from: 1, bitmap: rows(&["11111", "11001", "10011", "11111"]) }, New::Aggregate { parts: vec![(0, 0), (2, 3)], width: 7, height: 6 }];
    let table = custom(1, false);
    let d = Refagg {
        number: 12,
        huffman: true,
        r_template: 0,
        referred: &[1, 11],
        inputs: &input,
        new: &new,
        exports: &[false, false, false, true, true],
        reuse: false,
        retain: false,
        agg: Some(&table),
    };
    let (segment, _, exported) = refagg_dictionary(&d, None);
    let text = Text::new(16, 12);
    let placed = vec![at(0, 1, 0), at(1, 8, 0)];
    let mut stream = page(16, 12, 0);
    stream.extend(symbol_dictionary(1, &input));
    stream.extend(segment_with(11, 53, &[], table.segment.as_ref().unwrap()));
    stream.extend(segment);
    stream.extend(arithmetic_text(13, 6, &text, &exported, &placed, &[12]));
    assert_eq!(decoded(&stream, 16, 12), packed(&expected_text(&text, &exported, &placed)));
}

/// The segment of `bytes` (a segment written with no referred segments) renumbered, with the referred segments and the
/// page association the header allows for its number: two-byte referred numbers above 256, four-byte ones above 65536,
/// and a four-byte page association when `long_page`.
fn renumbered(bytes: &[u8], number: u32, referred: &[u32], long_page: bool) -> Vec<u8> {
    let kind = bytes[4];
    let data = &bytes[11..];
    let mut out = Vec::new();
    out.extend(be32(number));
    out.push(kind | if long_page { 0x40 } else { 0 });
    out.push((referred.len() as u8) << 5);
    for &r in referred {
        if number > 65536 {
            out.extend(be32(r));
        } else if number > 256 {
            out.extend((r as u16).to_be_bytes());
        } else {
            out.push(r as u8);
        }
    }
    if long_page {
        out.extend(be32(1));
    } else {
        out.push(1);
    }
    out.extend(be32(data.len() as u32));
    out.extend_from_slice(data);
    out
}

#[test]
fn segment_numbers_above_256_and_65536_and_a_four_byte_page_association_are_read() {
    let symbols = symbols();
    let text = Text::new(24, 16);
    let instances = text_instances();
    let expected = packed(&expected_text(&text, &symbols, &instances));
    for (dictionary, region, long_page) in [(1u32, 300u32, false), (300, 301, true), (70_000, 70_001, true)] {
        let mut stream = page(24, 16, 0);
        stream.extend(renumbered(&symbol_dictionary(1, &symbols), dictionary, &[], long_page));
        stream.extend(renumbered(&arithmetic_text(2, 6, &text, &symbols, &instances, &[]), region, &[dictionary], long_page));
        assert_eq!(decoded(&stream, 24, 16), expected, "segments {dictionary} and {region}");
    }
}

/// A text region of one instance of symbol 0 whose refinement changes the size by (`dw`, `dh`): only the sizes are coded,
/// because a size the decoder refuses is never decoded into.
fn refined_to_size(number: u32, dw: i64, dh: i64) -> Vec<u8> {
    let text = Text { refine: true, ..Text::new(24, 16) };
    let [time, first, delta, flag, rdw, rdh, rdx, rdy] = [0usize, 512, 1024, 2048, 2560, 3072, 3584, 4096];
    let ids = 4608usize;
    let mut coder = MqEncoder::new(ids + 8 + (1 << 13), &[]);
    encode_integer(&mut coder, time, Some(0));
    encode_integer(&mut coder, time, Some(1));
    encode_integer(&mut coder, first, Some(1));
    iaid(&mut coder, ids, 2, 0);
    encode_integer(&mut coder, flag, Some(1));
    for (base, value) in [(rdw, dw), (rdh, dh), (rdx, 0), (rdy, 0)] {
        encode_integer(&mut coder, base, Some(value));
    }
    encode_integer(&mut coder, delta, None);
    let mut data = text.head(None, 1);
    data.extend(coder.finish(true));
    segment_with(number, 6, &[1], &data)
}
/// Streams that end in a region or dictionary of each kind, with the sizes of the page.
fn region_streams() -> Vec<(&'static str, Vec<u8>, i32, i32)> {
    let symbols = symbols();
    let patterns = patterns();
    let black = bitmap();
    let (offsets, at_bytes) = template(0);
    let text = Text::new(24, 16);
    let instances = text_instances();
    let (coding, refer, refinement_at) = refinement_template(0);
    let (before, after) = refinement_pair();
    let halftone = Halftone::new(12, 8, vec![vec![0, 1, 2], vec![3, 2, 1]]);
    let mmr_halftone = Halftone { mmr: true, ..Halftone::new(12, 8, vec![vec![0, 1, 2], vec![3, 2, 1]]) };
    let refinement = refinement_body(region_info(16, 6, 0, 0, 4), 0, &refinement_at, encode_refinement(&after, &before, &coding, &refer));
    vec![
        ("generic", [page(16, 6, 0), generic_region(16, 6, 0, 0, 0, &at_bytes, &encode_generic(&black, &offsets))].concat(), 16, 6),
        ("mmr", [page(16, 5, 0), generic_region(8, 3, 4, 1, 1, &[], &pack_bits("001 1000 11 1   1 1 1   010 1 1"))].concat(), 16, 5),
        (
            "refinement",
            [page(16, 6, 0), generic_region(16, 6, 0, 0, 0, &at_bytes, &encode_generic(&before, &offsets)), segment_with(2, 42, &[], &refinement)].concat(),
            16,
            6,
        ),
        ("text", [page(24, 16, 0), symbol_dictionary(1, &symbols), arithmetic_text(2, 6, &text, &symbols, &instances, &[1])].concat(), 24, 16),
        ("huffman text", huffman_text_stream(&text, &symbols, &instances, &[1, 2, 2], &Tables::standard(0, 0, 0, 0)), 24, 16),
        ("dictionary", [page(24, 16, 0), symbol_dictionary(1, &symbols)].concat(), 24, 16),
        (
            "huffman dictionary",
            [page(24, 16, 0), huffman_dictionary(1, &symbols, false, &standard(0, B4, false), &standard(0, B2, true), &standard(0, B1, false), &[])].concat(),
            24,
            16,
        ),
        ("patterns", [page(12, 8, 0), pattern_dictionary(1, &patterns, 0, false)].concat(), 12, 8),
        ("halftone", halftone_stream(&halftone, &patterns, 0, 22), 12, 8),
        ("mmr halftone", halftone_stream(&mmr_halftone, &patterns, 0, 22), 12, 8),
        ("table", [page(24, 16, 0), segment(1, 53, custom(3, true).segment.as_ref().unwrap())].concat(), 24, 16),
    ]
}

#[test]
fn arithmetic_and_mmr_data_that_ends_early_decodes_as_far_as_it_goes() {
    // The decoders of these codes read missing bytes as the marker's 1 bits: nothing fails, and what the bytes present
    // determine is decoded.
    let cuts = [("generic", 5), ("mmr", 1), ("refinement", 3), ("text", 3), ("dictionary", 2), ("patterns", 8), ("halftone", 2), ("mmr halftone", 5)];
    for (name, stream, width, height) in region_streams() {
        let Some(&(_, cut)) = cuts.iter().find(|(n, _)| *n == name) else { continue };
        let whole = jbig2::decode(&stream, width, height, None).expect("the whole stream decodes");
        let short = jbig2::decode(&stream[..stream.len() - cut], width, height, None).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(short.len(), whole.len(), "{name}");
        if name == "generic" {
            // The first rows are coded in the bytes that are left.
            let pitch = 2;
            assert_eq!(short[..2 * pitch], whole[..2 * pitch]);
        }
    }
}

#[test]
fn huffman_data_that_ends_early_and_a_cut_header_fail_the_stream() {
    for (name, stream, width, height) in region_streams() {
        if matches!(name, "huffman text" | "huffman dictionary" | "table") {
            for cut in [1, 3, 8] {
                assert!(jbig2::decode(&stream[..stream.len() - cut], width, height, None).is_err(), "{name} without its last {cut} bytes");
            }
        }
        if name == "generic" {
            // Cut inside the region information, the segment header and the data length.
            for cut in [20, 25, 30] {
                assert!(jbig2::decode(&stream[..stream.len() - cut], width, height, None).is_err(), "{name} without its last {cut} bytes");
            }
        }
    }
}

#[test]
fn a_refined_symbol_the_decoder_cannot_draw_is_refused_before_anything_is_allocated() {
    let symbols = symbols();
    let blank = packed(&vec![vec![0u8; 24]; 16]);
    let run = |dw: i64, dh: i64| {
        let stream = [page(24, 16, 0), symbol_dictionary(1, &symbols), refined_to_size(2, dw, dh)].concat();
        let started = std::time::Instant::now();
        let out = jbig2::decode(&stream, 24, 16, None);
        (out, started.elapsed())
    };
    // No width: nothing can be composed, and the region fails.
    assert!(run(-3, 0).0.is_err());
    // Wider than any region may be (65535): the symbol is blank and the page is left as it was.
    assert_eq!(run(69_997, 0).0.expect("decodes"), blank);
    // 65535 x 65535 would need 512 MiB: the size check refuses it (and the region fails) in microseconds, not after
    // allocating and clearing the bitmap.
    let (out, took) = run(65_532, 65_531);
    assert!(out.is_err());
    assert!(took < std::time::Duration::from_secs(1), "{took:?}");
}

#[test]
fn symbols_without_pixels_place_nothing_or_fail_by_the_kind_of_dictionary() {
    let symbols = symbols();
    let text = Text::new(24, 16);
    let empty = vec![vec![]; 4];
    // Arithmetic dictionary: a symbol of no width has no bitmap, and an instance of it is skipped without being counted,
    // so the region of one counted instance after one such instance draws that one.
    let new = [symbols[0].clone(), empty.clone()];
    let d = Dict { number: 1, template: 0, retain: false, reuse: false, referred: &[], inputs: 0, new: &new, exports: &[true, true] };
    let (dictionary, _) = arithmetic_dictionary(&d, None);
    let mut region = arithmetic_text(2, 6, &text, &new, &[at(1, 5, 5), at(0, 1, 1)], &[1]);
    // The instance count follows the 12 byte segment header (one referred segment), the region information and the flags.
    region[12 + 17 + 2..12 + 17 + 6].copy_from_slice(&be32(1));
    let mut stream = page(24, 16, 0);
    stream.extend(dictionary);
    stream.extend(region);
    let only = expected_text(&text, &new, &[at(0, 1, 1)]);
    assert_eq!(decoded(&stream, 24, 16), packed(&only));
    // Huffman dictionary: the collective bitmap is cut into symbols, and one of no width is an image without pixels;
    // placing it fails the region, leaving it out does not.
    // (B.3 for the widths: the step from 3 to 0 is negative.)
    let dictionary = huffman_dictionary(1, &new, false, &standard(0, B4, false), &standard(1, B3, true), &standard(0, B1, false), &[]);
    for (placed, fails) in [(vec![at(1, 5, 5), at(0, 1, 1)], true), (vec![at(0, 1, 1), at(0, 9, 9)], false)] {
        let mut stream = page(24, 16, 0);
        stream.extend(dictionary.clone());
        stream.extend(arithmetic_text(2, 6, &text, &new, &placed, &[1]));
        assert_eq!(jbig2::decode(&stream, 24, 16, None).is_err(), fails);
    }
}
