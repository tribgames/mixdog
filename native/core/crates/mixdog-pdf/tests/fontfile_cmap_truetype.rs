//! CMaps (embedded, predefined packed) and the TrueType reader.
//!
//! The CMap tests replay `fixtures/pdf-cmap/cmaps.txt`, which `record_cmaps.mjs` (beside this file) records from
//! pdf.js 6.4.299: every predefined CMap (vertical flag, codespace ranges, size, a hash over all entries in order and
//! sixteen listed entries) and a set of embedded CMap texts (the entries in order, the codespace ranges and where
//! `readCharCode` reads codes). The TrueType tests build fonts by hand, and read the TrueType fonts embedded in the
//! corpus PDFs.

use std::collections::BTreeSet;
use std::io::Read;

use mixdog_pdf::Guard;
use mixdog_pdf::fontfile::cmap::bcmap::{BUILT_IN_CMAPS, built_in_cmap_data};
use mixdog_pdf::fontfile::cmap::{CMap, CMapEncoding, CMapFactory, CMapValue};
use mixdog_pdf::fontfile::truetype::{
    CmapMapping, MAC_STANDARD_GLYPH_ORDERING, TrueTypeFont,
};

// ---- the recorded CMaps ------------------------------------------------------------------------------------------

const RECORDED: &str = include_str!("../../../fixtures/pdf-cmap/cmaps.txt");

struct Block {
    head: Vec<String>,
    body: Vec<String>,
}

fn blocks() -> Vec<Block> {
    let mut out = Vec::new();
    let mut current: Option<Block> = None;
    for line in RECORDED.lines() {
        if line.starts_with("predef ") || line.starts_with("case ") {
            current = Some(Block {
                head: line.split(' ').map(str::to_owned).collect(),
                body: Vec::new(),
            });
        } else if line == "end" {
            out.extend(current.take());
        } else if let Some(block) = current.as_mut() {
            block.body.push(line.to_owned());
        }
    }
    out
}

fn unhex(text: &str) -> Vec<u8> {
    if text == "-" {
        return Vec::new();
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn repr(value: &CMapValue) -> String {
    match value {
        CMapValue::Cid(n) => format!("c{n}"),
        CMapValue::Str(units) => format!(
            "s{}",
            units
                .iter()
                .map(|unit| format!("{unit:x}"))
                .collect::<Vec<_>>()
                .join(".")
        ),
        CMapValue::Other => "o".to_owned(),
    }
}

fn parse_repr(text: &str) -> CMapValue {
    if let Some(number) = text.strip_prefix('c') {
        return CMapValue::Cid(number.parse().expect("number"));
    }
    let units = text.strip_prefix('s').expect("a string value");
    CMapValue::Str(if units.is_empty() {
        Vec::new()
    } else {
        units
            .split('.')
            .map(|unit| u16::from_str_radix(unit, 16).expect("unit"))
            .collect()
    })
}

fn fnv(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn codespace_list(cmap: &CMap) -> Vec<(usize, u32, u32)> {
    let mut out = Vec::new();
    for (width, ranges) in cmap.codespace_ranges().iter().enumerate() {
        for pair in ranges.chunks(2) {
            out.push((width + 1, pair[0], pair[1]));
        }
    }
    out
}

/// Checks a CMap against the lines recorded for it.
fn check_block(block: &Block) {
    let label = block.head[1].clone();
    let predefined = block.head[0] == "predef";
    let bytes = if predefined { Vec::new() } else { unhex(&block.head[2]) };
    let guard = Guard::unbounded();
    let encoding = if predefined {
        CMapEncoding::Name(&label)
    } else {
        CMapEncoding::Stream(&bytes)
    };
    let result = CMapFactory::create(Some(encoding), None, &guard);
    if block.body.iter().any(|line| line.starts_with("error")) {
        assert!(result.is_err(), "{label}: pdf.js fails, this does not");
        return;
    }
    let cmap = result.unwrap_or_else(|error| panic!("{label}: {error}"));
    let mut expected_ranges = Vec::new();
    let mut listed: Vec<(u32, CMapValue)> = Vec::new();
    for line in &block.body {
        let parts: Vec<&str> = line.split(' ').collect();
        match parts[0] {
            "kind" => {
                assert_eq!(
                    parts[1] == "identity",
                    cmap.is_identity_kind(),
                    "{label}: identity kind"
                );
            }
            "v" => assert_eq!(cmap.vertical, parts[1] == "1", "{label}: vertical"),
            "n" => assert_eq!(
                cmap.name,
                if parts[1] == "-" { "" } else { parts[1] },
                "{label}: name"
            ),
            "cs" => expected_ranges.push((
                parts[1].parse::<usize>().expect("width"),
                parts[2].parse::<u32>().expect("low"),
                parts[3].parse::<u32>().expect("high"),
            )),
            "size" => assert_eq!(
                cmap.size(),
                parts[1].parse::<usize>().expect("size"),
                "{label}: size"
            ),
            "hash" => {
                let mut text = String::new();
                cmap.for_each(|code, value| {
                    text.push_str(&format!("{code}={};", repr(value)));
                });
                assert_eq!(
                    format!("{:016x}", fnv(&text)),
                    parts[1],
                    "{label}: hash of the entries"
                );
            }
            "m" => listed.push((parts[1].parse().expect("code"), parse_repr(parts[2]))),
            "rc" => {
                let text = unhex(parts[1]);
                let offset: usize = parts[2].parse().expect("offset");
                let expected: (u32, usize) = (
                    parts[3].parse().expect("code"),
                    parts[4].parse().expect("length"),
                );
                assert_eq!(
                    cmap.read_char_code(&text, offset),
                    expected,
                    "{label}: readCharCode({}, {offset})",
                    parts[1]
                );
            }
            other => panic!("{label}: unknown recorded line {other}"),
        }
    }
    if !cmap.is_identity_kind() {
        assert_eq!(codespace_list(&cmap), expected_ranges, "{label}: codespace ranges");
    }
    if predefined {
        for (code, value) in &listed {
            assert_eq!(cmap.lookup(*code).as_ref(), Some(value), "{label}: lookup {code}");
        }
    } else {
        let entries = cmap.get_map();
        assert!(entries.len() >= listed.len().min(60), "{label}: entries");
        for (index, recorded) in listed.iter().enumerate() {
            assert_eq!(&entries[index], recorded, "{label}: entry {index} in order");
        }
    }
}

#[test]
fn every_predefined_cmap_matches_pdfjs() {
    let recorded: BTreeSet<String> = blocks()
        .iter()
        .filter(|block| block.head[0] == "predef")
        .map(|block| block.head[1].clone())
        .collect();
    let embedded: BTreeSet<String> = BUILT_IN_CMAPS
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect();
    assert_eq!(BUILT_IN_CMAPS.len(), 168);
    assert_eq!(recorded, embedded, "the recording covers the embedded CMaps");
    for (name, data) in BUILT_IN_CMAPS {
        assert!(!data.is_empty(), "{name} has data");
        assert_eq!(built_in_cmap_data(name), Some(*data));
    }
    for block in blocks().iter().filter(|block| block.head[0] == "predef") {
        check_block(block);
    }
}

#[test]
fn embedded_cmaps_match_pdfjs() {
    let cases: Vec<Block> = blocks()
        .into_iter()
        .filter(|block| block.head[0] == "case")
        .collect();
    assert!(cases.len() >= 20);
    for block in &cases {
        check_block(block);
    }
}

// ---- the CMap API ------------------------------------------------------------------------------------------------

fn create_stream(text: &str) -> CMap {
    CMapFactory::create(
        Some(CMapEncoding::Stream(text.as_bytes())),
        None,
        &Guard::unbounded(),
    )
    .expect("the CMap parses")
}

#[test]
fn identity_cmaps_are_built_in() {
    let guard = Guard::unbounded();
    let horizontal = CMapFactory::create(Some(CMapEncoding::Name("Identity-H")), None, &guard).unwrap();
    assert!(horizontal.is_identity_kind() && !horizontal.vertical);
    let vertical = CMapFactory::create(Some(CMapEncoding::Name("Identity-V")), None, &guard).unwrap();
    assert!(vertical.is_identity_kind() && vertical.vertical);
    assert_eq!(horizontal.lookup(0x1234), Some(CMapValue::Cid(0x1234)));
    assert_eq!(horizontal.lookup(0x1_0000), None);
    assert!(horizontal.contains(0xffff) && !horizontal.contains(0x1_0000));
    assert_eq!(horizontal.size(), 0x10000);
    assert_eq!(horizontal.read_char_code(&[0x12, 0x34], 0), (0x1234, 2));
    assert_eq!(horizontal.get_char_code_length(0x1234), 2);
    assert_eq!(horizontal.char_code_of(&CMapValue::Cid(77)), 77);
    assert_eq!(horizontal.char_code_of(&CMapValue::Cid(0x10000)), -1);
    assert_eq!(horizontal.get_map().len(), 0x10000);
}

#[test]
fn a_missing_or_unknown_encoding_is_an_error() {
    let guard = Guard::unbounded();
    assert!(CMapFactory::create(None, None, &guard).is_err());
    assert!(CMapFactory::create(Some(CMapEncoding::Name("NoSuchCMap")), None, &guard).is_err());
}

#[test]
fn use_cmap_extends_without_overriding() {
    let guard = Guard::unbounded();
    let cmap = CMapFactory::create(
        Some(CMapEncoding::Stream(b"1 begincidchar <0020> 7 endcidchar")),
        Some("UniJIS-UCS2-H"),
        &guard,
    )
    .unwrap();
    assert_eq!(cmap.lookup(0x20), Some(CMapValue::Cid(7)));
    assert!(cmap.lookup(0x21).is_some());
    assert_eq!(cmap.use_cmap.as_ref().map(|parent| parent.built_in), Some(true));
    assert!(!cmap.built_in);
    assert_eq!(cmap.num_codespace_ranges(), 2);
    // The parent's own entry is added after the child's: the child's place and value win.
    let first = &cmap.get_map()[0];
    assert_eq!(first, &(0x20, CMapValue::Cid(7)));
}

#[test]
fn a_range_past_the_limit_is_refused_and_the_rest_is_kept() {
    let mut cmap = CMap::new(false);
    assert!(cmap.map_cid_range(0, 0x00ff_ffff, 0).is_err());
    assert!(cmap.map_cid_range(10, 12, 100).is_ok());
    assert_eq!(cmap.lookup(11), Some(CMapValue::Cid(101)));
    assert_eq!(cmap.size(), 3);
    // An inverted range maps nothing and costs nothing.
    assert!(cmap.map_cid_range(9, 5, 0).is_ok());
    assert_eq!(cmap.size(), 3);
}

#[test]
fn mapping_a_code_again_keeps_its_place() {
    let mut cmap = CMap::new(false);
    cmap.map_one(2, CMapValue::Cid(1));
    cmap.map_one(1, CMapValue::Cid(2));
    cmap.map_one(2, CMapValue::Cid(3));
    assert_eq!(
        cmap.get_map(),
        vec![(2, CMapValue::Cid(3)), (1, CMapValue::Cid(2))]
    );
    assert_eq!(cmap.char_code_of(&CMapValue::Cid(2)), 1);
    assert_eq!(cmap.char_code_of(&CMapValue::Cid(1)), -1);
}

#[test]
fn bfrange_counts_up_the_last_unit_of_the_start_string() {
    let mut cmap = CMap::new(false);
    cmap.map_bf_range(0, 2, vec![0x00, 0xfe]).unwrap();
    assert_eq!(cmap.lookup(0), Some(CMapValue::Str(vec![0, 0xfe])));
    assert_eq!(cmap.lookup(1), Some(CMapValue::Str(vec![0, 0xff])));
    assert_eq!(cmap.lookup(2), Some(CMapValue::Str(vec![1, 0])));
    let mut cmap = CMap::new(false);
    cmap.map_bf_range_to_array(
        5,
        9,
        vec![CMapValue::Cid(1), CMapValue::Str(vec![0x41]), CMapValue::Other],
    )
    .unwrap();
    assert_eq!(cmap.size(), 3);
    assert_eq!(cmap.lookup(6), Some(CMapValue::Str(vec![0x41])));
    assert_eq!(cmap.char_code_of(&CMapValue::Other), -1);
}

#[test]
fn read_char_code_follows_the_codespace_ranges() {
    let cmap = create_stream(
        "2 begincodespacerange <00> <7f> <8140> <fefe> endcodespacerange",
    );
    assert_eq!(cmap.read_char_code(b"A", 0), (0x41, 1));
    assert_eq!(cmap.read_char_code(&[0x81, 0x40], 0), (0x8140, 2));
    // No range holds the code: the code is 0 and one byte is consumed.
    assert_eq!(cmap.read_char_code(&[0x80, 0x00], 0), (0, 1));
    // Past the end, the missing byte is 0.
    assert_eq!(cmap.read_char_code(&[0x81], 0), (0, 1));
    assert_eq!(cmap.get_char_code_length(0x8140), 2);
    assert_eq!(cmap.get_char_code_length(0x7f), 1);
    assert_eq!(cmap.get_char_code_length(0xffff_ffff), 1);
}

#[test]
fn the_packed_files_carry_their_wmode_and_codespace() {
    let guard = Guard::unbounded();
    let vertical =
        CMapFactory::create(Some(CMapEncoding::Name("UniJIS-UCS2-V")), None, &guard).unwrap();
    assert!(vertical.vertical && vertical.built_in);
    let horizontal =
        CMapFactory::create(Some(CMapEncoding::Name("UniJIS-UCS2-H")), None, &guard).unwrap();
    assert!(!horizontal.vertical);
    // The vertical file extends the horizontal one.
    assert!(vertical.use_cmap.is_some());
    assert!(horizontal.size() > 9000);
    assert_eq!(vertical.num_codespace_ranges(), horizontal.num_codespace_ranges());
}

// ---- hand-made TrueType fonts ------------------------------------------------------------------------------------

fn push16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

/// A font file: the header, the directory and the tables, table offsets counted from the start of the whole file
/// (`base` is where this font starts in it).
fn build_font(version: &[u8; 4], tables: &[(&str, Vec<u8>)], base: usize) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(version);
    push16(&mut out, tables.len() as u16);
    push16(&mut out, 0);
    push16(&mut out, 0);
    push16(&mut out, 0);
    let data_start = base + 12 + 16 * tables.len();
    let mut body: Vec<u8> = Vec::new();
    for (tag, data) in tables {
        assert_eq!(tag.len(), 4);
        out.extend_from_slice(tag.as_bytes());
        push32(&mut out, 0);
        push32(&mut out, (data_start + body.len()) as u32);
        push32(&mut out, data.len() as u32);
        body.extend_from_slice(data);
        while body.len() % 4 != 0 {
            body.push(0);
        }
    }
    out.extend_from_slice(&body);
    out
}

fn head_table(units_per_em: u16, y_min: i16, y_max: i16, index_to_loc_format: i16) -> Vec<u8> {
    let mut head = vec![0u8; 54];
    head[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
    head[18..20].copy_from_slice(&units_per_em.to_be_bytes());
    head[38..40].copy_from_slice(&y_min.to_be_bytes());
    head[42..44].copy_from_slice(&y_max.to_be_bytes());
    head[50..52].copy_from_slice(&index_to_loc_format.to_be_bytes());
    head
}

fn hhea_table(ascent: i16, descent: i16, line_gap: i16) -> Vec<u8> {
    let mut hhea = vec![0u8; 36];
    hhea[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
    hhea[4..6].copy_from_slice(&ascent.to_be_bytes());
    hhea[6..8].copy_from_slice(&descent.to_be_bytes());
    hhea[8..10].copy_from_slice(&line_gap.to_be_bytes());
    hhea
}

fn maxp_table(num_glyphs: u16) -> Vec<u8> {
    let mut maxp = vec![0u8; 32];
    maxp[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
    maxp[4..6].copy_from_slice(&num_glyphs.to_be_bytes());
    maxp
}

/// Five glyphs: 0 and 2 simple, 1 empty, 3 a composite that contains itself, 4 a composite of glyph 0.
fn glyf_table() -> Vec<u8> {
    let simple: [u8; 20] = [
        0, 1, 0, 0, 0, 0, 0, 10, 0, 10, // header: one contour, the box
        0, 0, // end point of the contour
        0, 0, // no instructions
        0x01, // flag: on curve, two bytes each for x and y
        0, 0, 0, 0, // the coordinates
        0, // padding
    ];
    let composite = |glyph: u16| {
        let mut bytes = vec![0xff, 0xff, 0, 0, 0, 0, 0, 10, 0, 10];
        push16(&mut bytes, 0); // flags: no more components, byte arguments
        push16(&mut bytes, glyph);
        bytes.extend_from_slice(&[0, 0]);
        bytes
    };
    let mut glyf = Vec::new();
    glyf.extend_from_slice(&simple);
    glyf.extend_from_slice(&simple);
    glyf.extend_from_slice(&composite(3));
    glyf.extend_from_slice(&composite(0));
    glyf
}

/// The offsets of the glyphs of [`glyf_table`]: glyph 1 has no bytes.
const GLYPH_OFFSETS: [u32; 6] = [0, 20, 20, 40, 56, 72];

fn loca_table(long: bool) -> Vec<u8> {
    let mut loca = Vec::new();
    for offset in GLYPH_OFFSETS {
        if long {
            push32(&mut loca, offset);
        } else {
            push16(&mut loca, (offset / 2) as u16);
        }
    }
    loca
}

/// A `cmap` table with the given encoding records `(platform, encoding, subtable)`.
fn cmap_table(records: &[(u16, u16, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 0);
    push16(&mut out, records.len() as u16);
    let mut offset = 4 + 8 * records.len();
    for (platform, encoding, subtable) in records {
        push16(&mut out, *platform);
        push16(&mut out, *encoding);
        push32(&mut out, offset as u32);
        offset += subtable.len();
    }
    for (_, _, subtable) in records {
        out.extend_from_slice(subtable);
    }
    out
}

fn format0(glyphs: &[(u8, u8)]) -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 0);
    push16(&mut out, 262);
    push16(&mut out, 0);
    let mut array = [0u8; 256];
    for (code, glyph) in glyphs {
        array[usize::from(*code)] = *glyph;
    }
    out.extend_from_slice(&array);
    out
}

/// Two segments: 0x41 to 0x43 by an id delta to glyphs 1 to 3, and the closing 0xffff.
fn format4_delta() -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 4);
    push16(&mut out, 32);
    push16(&mut out, 0);
    push16(&mut out, 4); // segCountX2
    push16(&mut out, 0);
    push16(&mut out, 0);
    push16(&mut out, 0);
    for end in [0x43, 0xffff] {
        push16(&mut out, end);
    }
    push16(&mut out, 0); // reservedPad
    for start in [0x41, 0xffff] {
        push16(&mut out, start);
    }
    push16(&mut out, (1u16).wrapping_sub(0x41)); // idDelta: 0x41 -> 1
    push16(&mut out, 1);
    push16(&mut out, 0); // idRangeOffset
    push16(&mut out, 0);
    out
}

/// One segment 0x30 to 0x32 whose glyphs come from the glyph id array.
fn format4_range_offset() -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 4);
    push16(&mut out, 26);
    push16(&mut out, 0);
    push16(&mut out, 2);
    push16(&mut out, 0);
    push16(&mut out, 0);
    push16(&mut out, 0);
    push16(&mut out, 0x32); // end
    push16(&mut out, 0); // reservedPad
    push16(&mut out, 0x30); // start
    push16(&mut out, 0); // idDelta
    push16(&mut out, 2); // idRangeOffset: the array follows
    for glyph in [7, 8, 9] {
        push16(&mut out, glyph);
    }
    out
}

fn format6(first_code: u16, glyphs: &[u16]) -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 6);
    push16(&mut out, (10 + 2 * glyphs.len()) as u16);
    push16(&mut out, 0);
    push16(&mut out, first_code);
    push16(&mut out, glyphs.len() as u16);
    for glyph in glyphs {
        push16(&mut out, *glyph);
    }
    out
}

fn format12(groups: &[(u32, u32, u32)]) -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 12);
    push16(&mut out, 0);
    push32(&mut out, (16 + 12 * groups.len()) as u32);
    push32(&mut out, 0);
    push32(&mut out, groups.len() as u32);
    for (start, end, glyph) in groups {
        push32(&mut out, *start);
        push32(&mut out, *end);
        push32(&mut out, *glyph);
    }
    out
}

/// Format 2 with every key 0: one sub-header whose glyph index array is read for the codes 0 to 255.
fn format2(glyphs: &[u16]) -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 2);
    push16(&mut out, 0);
    push16(&mut out, 0);
    for _ in 0..256 {
        push16(&mut out, 0);
    }
    push16(&mut out, 0); // firstCode
    push16(&mut out, 256); // entryCount
    push16(&mut out, 0); // idDelta
    push16(&mut out, 2); // idRangeOffset: the array follows
    for code in 0..256 {
        push16(&mut out, glyphs.get(code).copied().unwrap_or(0));
    }
    out
}

fn post_table(version: u32, names: &[u16], custom: &[&str]) -> Vec<u8> {
    let mut post = vec![0u8; 32];
    post[..4].copy_from_slice(&version.to_be_bytes());
    if version == 0x0002_0000 {
        post.truncate(32);
        push16(&mut post, names.len() as u16);
        for index in names {
            push16(&mut post, *index);
        }
        for name in custom {
            post.push(name.len() as u8);
            post.extend_from_slice(name.as_bytes());
        }
    }
    post
}

fn name_table(records: &[(u16, u16, u16, u16, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    push16(&mut out, 0);
    push16(&mut out, records.len() as u16);
    push16(&mut out, (6 + 12 * records.len()) as u16);
    let mut offset = 0;
    for (platform, encoding, language, id, text) in records {
        push16(&mut out, *platform);
        push16(&mut out, *encoding);
        push16(&mut out, *language);
        push16(&mut out, *id);
        push16(&mut out, text.len() as u16);
        push16(&mut out, offset);
        offset += text.len() as u16;
    }
    for (_, _, _, _, text) in records {
        out.extend_from_slice(text);
    }
    out
}

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

fn os2_table(version: u16, selection: u16, first: u16, last: u16, win_ascent: u16, len: usize) -> Vec<u8> {
    let mut os2 = vec![0u8; len];
    os2[..2].copy_from_slice(&version.to_be_bytes());
    os2[62..64].copy_from_slice(&selection.to_be_bytes());
    os2[64..66].copy_from_slice(&first.to_be_bytes());
    os2[66..68].copy_from_slice(&last.to_be_bytes());
    os2[74..76].copy_from_slice(&win_ascent.to_be_bytes());
    os2
}

/// The tables of a complete small font, with `cmap` replaced.
fn font_with_cmap(cmap: Vec<u8>) -> Vec<u8> {
    build_font(
        b"\0\x01\0\0",
        &[
            ("cmap", cmap),
            ("head", head_table(1000, -200, 900, 0)),
            ("hhea", hhea_table(800, -200, 0)),
            ("maxp", maxp_table(5)),
            ("loca", loca_table(false)),
            ("glyf", glyf_table()),
            ("post", post_table(0x0003_0000, &[], &[])),
        ],
        0,
    )
}

fn parse(bytes: &[u8]) -> TrueTypeFont {
    TrueTypeFont::parse(bytes, "Test").expect("the font parses")
}

fn pairs(mappings: &[CmapMapping]) -> Vec<(i64, i64)> {
    mappings.iter().map(|m| (m.char_code, m.glyph_id)).collect()
}

#[test]
fn the_table_directory_keeps_valid_tables_with_data() {
    let font = build_font(
        b"\0\x01\0\0",
        &[
            ("head", head_table(1000, 0, 0, 0)),
            ("xxxx", vec![1, 2, 3, 4]),
            ("hhea", Vec::new()),
            ("maxp", maxp_table(5)),
            ("head", head_table(2048, 0, 0, 0)),
        ],
        0,
    );
    let font = parse(&font);
    assert_eq!(font.header_version(), "\0\x01\0\0");
    let tags: Vec<&str> = font.tables().iter().map(|t| t.tag.as_str()).collect();
    // The unknown tag and the empty table are dropped; the later head replaces the earlier one in its place.
    assert_eq!(tags, ["head", "maxp"]);
    assert_eq!(font.table_data("head").unwrap()[18..20], 2048u16.to_be_bytes());
    assert!(font.is_true_type());
}

#[test]
fn an_empty_or_garbage_file_has_no_tables() {
    for bytes in [&[][..], &[0u8; 3][..], &[0xffu8; 40][..], b"true"] {
        let font = parse(bytes);
        assert!(font.tables().is_empty());
        assert_eq!(font.read_cmap_table(false, false).unwrap().platform_id, -1);
        assert!(font.read_post_script_table(1).is_none());
        assert!(font.read_name_table().is_none());
        assert!(!font.validate_os2_table());
        assert!(font.glyph_info(None).is_err());
        assert!(font.metrics_override().is_err());
    }
}

#[test]
fn cmap_formats_0_4_6_12_and_2_read_their_mappings() {
    let cases: Vec<(Vec<u8>, Vec<(i64, i64)>, bool)> = vec![
        (
            format0(&[(0x41, 1), (0x42, 2), (0x20, 3)]),
            vec![(0x20, 3), (0x41, 1), (0x42, 2)],
            true,
        ),
        (
            format4_delta(),
            vec![(0x41, 1), (0x42, 2), (0x43, 3)],
            false,
        ),
        (
            format4_range_offset(),
            vec![(0x30, 7), (0x31, 8), (0x32, 9)],
            false,
        ),
        (
            format6(0x20, &[5, 6, 7]),
            vec![(0x20, 5), (0x21, 6), (0x22, 7)],
            false,
        ),
        (
            format12(&[(0x1f600, 0x1f602, 10), (0x41, 0x41, 4)]),
            vec![(0x41, 4), (0x1f600, 10), (0x1f601, 11), (0x1f602, 12)],
            false,
        ),
    ];
    for (subtable, expected, short) in cases {
        let font = parse(&font_with_cmap(cmap_table(&[(3, 1, subtable)])));
        let cmap = font.read_cmap_table(false, false).unwrap();
        assert_eq!((cmap.platform_id, cmap.encoding_id), (3, 1));
        assert_eq!(pairs(&cmap.mappings), expected);
        assert_eq!(cmap.has_short_cmap, short);
    }
    let font = parse(&font_with_cmap(cmap_table(&[(1, 0, format2(&[5, 6, 7, 8]))])));
    let cmap = font.read_cmap_table(false, false).unwrap();
    assert_eq!(cmap.mappings.len(), 256);
    assert_eq!(pairs(&cmap.mappings[..4]), [(0, 5), (1, 6), (2, 7), (3, 8)]);
}

#[test]
fn a_cmap_format_pdfjs_cannot_read_gives_no_mappings() {
    // Format 10 is not read by pdf.js 6.4.299 (it warns that the format is unsupported).
    let mut format10 = Vec::new();
    push16(&mut format10, 10);
    push16(&mut format10, 0);
    push32(&mut format10, 20);
    push32(&mut format10, 0);
    push32(&mut format10, 0x20);
    push32(&mut format10, 1);
    push16(&mut format10, 3);
    let font = parse(&font_with_cmap(cmap_table(&[(3, 1, format10)])));
    let cmap = font.read_cmap_table(false, false).unwrap();
    assert_eq!((cmap.platform_id, cmap.encoding_id), (-1, -1));
    assert!(cmap.mappings.is_empty());
}

#[test]
fn the_first_mapping_of_a_repeated_code_is_kept_and_the_result_is_sorted() {
    let font = parse(&font_with_cmap(cmap_table(&[(
        3,
        1,
        format12(&[(0x50, 0x51, 5), (0x40, 0x41, 1), (0x41, 0x41, 99)]),
    )])));
    let cmap = font.read_cmap_table(false, false).unwrap();
    assert_eq!(pairs(&cmap.mappings), [(0x40, 1), (0x41, 2), (0x50, 5), (0x51, 6)]);
}

#[test]
fn the_cmap_subtable_is_chosen_as_pdfjs_chooses() {
    let table = |encodings: &[(u16, u16)]| {
        let records: Vec<(u16, u16, Vec<u8>)> = encodings
            .iter()
            .map(|(platform, encoding)| {
                // Each subtable maps one code, so the chosen one shows in the mapping.
                let glyph = platform * 10 + encoding;
                (*platform, *encoding, format6(0x41, &[glyph]))
            })
            .collect();
        parse(&font_with_cmap(cmap_table(&records)))
    };
    let chosen = |font: &TrueTypeFont, symbolic: bool, has_encoding: bool| {
        let cmap = font.read_cmap_table(symbolic, has_encoding).unwrap();
        (cmap.platform_id, cmap.encoding_id, cmap.mappings[0].glyph_id)
    };
    // Unicode, Mac Roman and Windows Unicode: the Windows one is used only when the font has an encoding.
    let font = table(&[(0, 3), (1, 0), (3, 1)]);
    assert_eq!(chosen(&font, false, false), (1, 0, 10));
    assert_eq!(chosen(&font, false, true), (3, 1, 31));
    // Windows Unicode alone is used even without an encoding, and stops the search for a non-symbolic font.
    let font = table(&[(3, 1), (1, 0)]);
    assert_eq!(chosen(&font, false, false), (3, 1, 31));
    // A symbolic font takes (3, 0) when the records are sorted.
    let font = table(&[(1, 0), (3, 0), (3, 1)]);
    assert_eq!(chosen(&font, true, false), (3, 0, 30));
    // A record of the same platform and encoding as the chosen one is skipped.
    let font = table(&[(1, 0), (1, 0)]);
    assert_eq!(chosen(&font, false, false), (1, 0, 10));
    // Nothing usable: no mappings.
    let font = table(&[(2, 1)]);
    assert_eq!(font.read_cmap_table(false, false).unwrap().platform_id, -1);
    let no_cmap = build_font(b"\0\x01\0\0", &[("head", head_table(1000, 0, 0, 0))], 0);
    assert_eq!(parse(&no_cmap).read_cmap_table(false, false).unwrap().platform_id, -1);
}

#[test]
fn a_cmap_cut_short_reads_what_is_there() {
    let full = font_with_cmap(cmap_table(&[(3, 1, format6(0x20, &[5, 6, 7]))]));
    let font = parse(&full);
    let cmap_offset = font.table("cmap").unwrap().offset as usize;
    // The file ends inside the subtable: pdf.js's reads give -1 past the end, one glyph is read as -1.
    let cut = &full[..cmap_offset + 4 + 8 + 10 + 2];
    let font = parse(cut);
    let cmap = font.read_cmap_table(false, false).unwrap();
    assert_eq!(pairs(&cmap.mappings), [(0x20, 5), (0x21, -1), (0x22, -1)]);
    // The file ends before the subtable starts.
    let font = parse(&full[..cmap_offset + 4 + 8]);
    assert_eq!(font.read_cmap_table(false, false).unwrap().platform_id, -1);
}

#[test]
fn post_glyph_names() {
    let with_post = |post: Vec<u8>| {
        parse(&build_font(
            b"\0\x01\0\0",
            &[("head", head_table(1000, 0, 0, 0)), ("post", post)],
            0,
        ))
    };
    let font = with_post(post_table(0x0001_0000, &[], &[]));
    let post = font.read_post_script_table(5).unwrap();
    assert!(post.valid);
    let names = post.glyph_names.unwrap();
    assert_eq!(names.len(), 258);
    assert_eq!(names[36].as_deref(), Some("A"));
    assert_eq!(MAC_STANDARD_GLYPH_ORDERING[36], "A");

    let font = with_post(post_table(0x0002_0000, &[0, 36, 258, 260], &["foo", "bar", "baz"]));
    let post = font.read_post_script_table(4).unwrap();
    assert!(post.valid);
    assert_eq!(
        post.glyph_names.unwrap(),
        [
            Some(".notdef".to_owned()),
            Some("A".to_owned()),
            Some("foo".to_owned()),
            Some("baz".to_owned())
        ]
    );
    // A glyph count that is not maxp's makes the table invalid, with no names.
    let post = font.read_post_script_table(5).unwrap();
    assert!(!post.valid && post.glyph_names.is_none() && !post.unsupported_version);

    // A name index past the custom names is `undefined`.
    let font = with_post(post_table(0x0002_0000, &[259], &["foo"]));
    assert_eq!(font.read_post_script_table(1).unwrap().glyph_names.unwrap(), [None]);

    // An index of 32768 or more invalidates the table.
    let font = with_post(post_table(0x0002_0000, &[32768], &[]));
    assert!(!font.read_post_script_table(1).unwrap().valid);

    let font = with_post(post_table(0x0003_0000, &[], &[]));
    let post = font.read_post_script_table(5).unwrap();
    assert!(post.valid && post.glyph_names.is_none());

    let font = with_post(post_table(0x0004_0000, &[], &[]));
    let post = font.read_post_script_table(5).unwrap();
    assert!(!post.valid && post.unsupported_version);
}

#[test]
fn the_name_table_gives_ascii_and_utf16_names_for_mac_and_windows_records() {
    let table = name_table(&[
        (1, 0, 0, 6, &b"Test-Regular"[..]),
        (3, 1, 0x409, 6, &utf16("Wide Name")[..]),
        (3, 1, 0x409, 1, &utf16("Family")[..]),
        (3, 1, 0x411, 2, &utf16("Other language")[..]),
        (0, 3, 0, 4, &b"Unicode record"[..]),
    ]);
    let font = parse(&build_font(b"\0\x01\0\0", &[("name", table)], 0));
    let names = font.read_name_table().unwrap();
    assert_eq!(names.ps_name(), Some("Test-Regular"));
    assert_eq!(names.names[1].get(&6).map(String::as_str), Some("Wide Name"));
    assert_eq!(names.names[1].get(&1).map(String::as_str), Some("Family"));
    assert_eq!(names.records.len(), 3);
    assert!(names.records[0].is_mac() && !names.records[0].is_win());
    assert!(names.records[1].is_win());
    assert!(!names.names[0].contains_key(&2) && !names.names[1].contains_key(&2));
}

#[test]
fn os2_tables_are_validated_as_pdfjs_validates_them() {
    let validate = |os2: Vec<u8>| {
        parse(&build_font(b"\0\x01\0\0", &[("OS/2", os2)], 0)).validate_os2_table()
    };
    assert!(validate(os2_table(0, 0, 0x20, 0x7e, 800, 78)));
    assert!(validate(os2_table(1, 0, 0x20, 0x7e, 800, 86)));
    assert!(validate(os2_table(5, 0x0300, 0x20, 0x7e, 800, 100)));
    // Too short for its version, an unknown version, a selection bit of an old version, first > last, no ascent.
    assert!(!validate(os2_table(0, 0, 0x20, 0x7e, 800, 77)));
    assert!(!validate(os2_table(6, 0, 0x20, 0x7e, 800, 120)));
    assert!(!validate(os2_table(3, 0x0100, 0x20, 0x7e, 800, 96)));
    assert!(!validate(os2_table(0, 0, 0x7f, 0x7e, 800, 78)));
    assert!(!validate(os2_table(0, 0, 0x20, 0x7e, 0, 78)));
    let no_os2 = parse(&build_font(b"\0\x01\0\0", &[("head", head_table(1000, 0, 0, 0))], 0));
    assert!(!no_os2.validate_os2_table());
}

#[test]
fn metrics_come_from_head_and_hhea() {
    let font = parse(&font_with_cmap(cmap_table(&[(3, 1, format6(0x20, &[1]))])));
    let metrics = font.metrics_override().unwrap();
    assert_eq!(metrics.units_per_em, Some(1000));
    assert_eq!((metrics.y_min, metrics.y_max), (Some(-200), Some(900)));
    assert!((metrics.ascent_ratio() - 0.8).abs() < 1e-12);
    assert!((metrics.descent_ratio() + 0.2).abs() < 1e-12);
    assert!(metrics.line_gap_ratio().abs() < 1e-12);
    // A head table that is too short has no unitsPerEm: the ratios are NaN.
    let short = parse(&build_font(
        b"\0\x01\0\0",
        &[("head", vec![0; 10]), ("hhea", hhea_table(800, -200, 0))],
        0,
    ));
    let metrics = short.metrics_override().unwrap();
    assert_eq!(metrics.units_per_em, None);
    assert!(metrics.ascent_ratio().is_nan());
}

#[test]
fn glyphs_without_data_are_missing() {
    let font = parse(&font_with_cmap(cmap_table(&[(3, 1, format6(0x20, &[1]))])));
    let info = font.glyph_info(None).unwrap();
    assert_eq!(info.num_glyphs, 5);
    assert!(!info.is_glyph_locations_long);
    // Glyph 1 has no bytes; glyph 3 is a composite that contains itself and loses its only component.
    assert_eq!(
        info.missing_glyphs.as_deref(),
        Some(&[false, true, false, true, false][..])
    );
    assert!(info.has_glyph(0) && !info.has_glyph(1) && !info.has_glyph(3) && info.has_glyph(4));
    // A glyph id outside the font is "not missing" (`!undefined`), as in pdf.js.
    assert!(info.has_glyph(99) && info.has_glyph(-1));
}

#[test]
fn long_glyph_locations_give_the_same_answer() {
    let font = build_font(
        b"\0\x01\0\0",
        &[
            ("head", head_table(1000, 0, 0, 1)),
            ("hhea", hhea_table(0, 0, 0)),
            ("maxp", maxp_table(5)),
            ("loca", loca_table(true)),
            ("glyf", glyf_table()),
        ],
        0,
    );
    let info = parse(&font).glyph_info(None).unwrap();
    assert!(info.is_glyph_locations_long);
    assert_eq!(
        info.missing_glyphs.as_deref(),
        Some(&[false, true, false, true, false][..])
    );
}

#[test]
fn a_short_loca_table_is_read_with_zeros_after_its_end() {
    let mut loca = loca_table(false);
    loca.truncate(loca.len() - 2);
    let font = build_font(
        b"\0\x01\0\0",
        &[
            ("head", head_table(1000, 0, 0, 0)),
            ("hhea", hhea_table(0, 0, 0)),
            ("maxp", maxp_table(5)),
            ("loca", loca),
            ("glyf", glyf_table()),
        ],
        0,
    );
    let info = parse(&font).glyph_info(None).unwrap();
    assert_eq!(info.missing_glyphs.as_ref().map(Vec::len), Some(5));
}

/// A font with the given `maxp`, `head` and `loca`, and `skip` left out.
fn font_of(skip: &str, maxp: Vec<u8>, head: Vec<u8>, loca: Vec<u8>) -> TrueTypeFont {
    let all = [
        ("head", head),
        ("hhea", hhea_table(0, 0, 0)),
        ("maxp", maxp),
        ("loca", loca),
        ("glyf", glyf_table()),
    ];
    let kept: Vec<(&str, Vec<u8>)> = all.into_iter().filter(|(tag, _)| *tag != skip).collect();
    parse(&build_font(b"\0\x01\0\0", &kept, 0))
}

fn glyph_error(font: &TrueTypeFont) -> String {
    font.glyph_info(None).unwrap_err().to_string()
}

#[test]
fn required_tables_and_versions_are_checked_in_pdfjs_order() {
    let head = || head_table(1000, 0, 0, 0);
    let loca = || loca_table(false);
    assert!(glyph_error(&font_of("loca", maxp_table(5), head(), loca())).contains("loca"));
    assert!(glyph_error(&font_of("maxp", maxp_table(5), head(), loca())).contains("maxp"));
    assert!(glyph_error(&font_of("head", maxp_table(5), head(), loca())).contains("head"));
    assert!(glyph_error(&font_of("hhea", maxp_table(5), head(), loca())).contains("hhea"));
    // A maxp of an unknown version is accepted by its length (6 or at least 32), refused otherwise.
    let mut odd = maxp_table(5);
    odd[..4].copy_from_slice(&0x0002_0000_u32.to_be_bytes());
    assert!(font_of("none", odd.clone(), head(), loca()).glyph_info(None).is_ok());
    odd.truncate(8);
    assert!(glyph_error(&font_of("none", odd.clone(), head(), loca())).contains("maxp"));
    odd.truncate(6);
    assert!(font_of("none", odd, head(), loca()).glyph_info(None).is_ok());
}

#[test]
fn an_invalid_index_to_loc_format_is_fixed_only_when_loca_says_which_it_is() {
    // A long loca of the right length for the glyph count: the format is fixed, the glyphs are read as long.
    let fixed = font_of("none", maxp_table(5), head_table(1000, 0, 0, 7), loca_table(true));
    let info = fixed.glyph_info(None).unwrap();
    assert!(info.is_glyph_locations_long);
    assert_eq!(info.missing_glyphs.as_ref().map(Vec::len), Some(5));
    // A loca that fits neither length for nine glyphs: pdf.js throws.
    let broken = font_of("none", maxp_table(9), head_table(1000, 0, 0, 7), loca_table(false));
    assert!(glyph_error(&broken).contains("indexToLocFormat"));
}

#[test]
fn opentype_fonts_with_cff_outlines_have_no_missing_glyph_table() {
    let font = build_font(
        b"OTTO",
        &[
            ("head", head_table(1000, 0, 0, 0)),
            ("hhea", hhea_table(0, 0, 0)),
            ("maxp", maxp_table(0)),
            ("CFF ", vec![1, 0, 4, 1, 0, 0, 0, 0]),
        ],
        0,
    );
    let font = parse(&font);
    assert!(!font.is_true_type());
    assert_eq!(font.header_version(), "OTTO");
    let info = font.glyph_info(Some(7)).unwrap();
    assert_eq!(info.num_glyphs, 7);
    assert!(info.missing_glyphs.is_none() && info.has_glyph(3));
}

fn collection(names: &[&str]) -> Vec<u8> {
    let count = names.len();
    let header_len = 12 + 4 * count;
    let mut fonts: Vec<Vec<u8>> = Vec::new();
    let mut offsets = Vec::new();
    let mut at = header_len;
    for name in names {
        let table = name_table(&[(1, 0, 0, 4, name.as_bytes())]);
        let font = build_font(
            b"\0\x01\0\0",
            &[("name", table), ("head", head_table(1000, 0, 0, 0))],
            at,
        );
        offsets.push(at as u32);
        at += font.len() + 16 + 4 * 4;
        let mut padded = font;
        padded.resize(padded.len() + 16 + 4 * 4, 0);
        fonts.push(padded);
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"ttcf");
    push16(&mut out, 1);
    push16(&mut out, 0);
    push32(&mut out, count as u32);
    for offset in offsets {
        push32(&mut out, offset);
    }
    for font in fonts {
        out.extend_from_slice(&font);
    }
    out
}

#[test]
fn a_collection_gives_the_font_with_the_requested_name() {
    let file = collection(&["Alpha Font", "Beta"]);
    let beta = TrueTypeFont::parse(&file, "Beta").unwrap();
    assert_eq!(beta.read_name_table().unwrap().names[0].get(&4).map(String::as_str), Some("Beta"));
    // Whitespace of the font's names does not count, and a subset prefix falls back to the part after it.
    let alpha = TrueTypeFont::parse(&file, "AlphaFont").unwrap();
    assert_eq!(alpha.read_name_table().unwrap().names[0].get(&4).map(String::as_str), Some("Alpha Font"));
    let prefixed = TrueTypeFont::parse(&file, "ABCDEF+Beta").unwrap();
    assert_eq!(prefixed.read_name_table().unwrap().names[0].get(&4).map(String::as_str), Some("Beta"));
    assert!(TrueTypeFont::parse(&file, "Gamma").is_err());
    let mut version3 = file.clone();
    version3[4..6].copy_from_slice(&3u16.to_be_bytes());
    assert!(TrueTypeFont::parse(&version3, "Beta").is_err());
}

// ---- the fonts of the corpus PDFs --------------------------------------------------------------------------------

/// The decoded streams of a PDF that are TrueType fonts (found by scanning for streams, no PDF parsing).
fn embedded_truetype_fonts(pdf: &[u8]) -> Vec<Vec<u8>> {
    let mut fonts = Vec::new();
    let mut from = 0;
    while let Some(found) = find(pdf, b"stream", from) {
        let mut start = found + 6;
        if pdf.get(start) == Some(&b'\r') {
            start += 1;
        }
        if pdf.get(start) == Some(&b'\n') {
            start += 1;
        }
        let Some(end) = find(pdf, b"endstream", start) else {
            break;
        };
        let mut decoded = Vec::new();
        if flate2::read::ZlibDecoder::new(&pdf[start..end])
            .read_to_end(&mut decoded)
            .is_ok()
            && matches!(decoded.get(..4), Some(b"\0\x01\0\0" | b"true"))
        {
            fonts.push(decoded);
        }
        from = end + 9;
    }
    fonts
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

const CORPUS_FONT_FILES: [(&str, &[u8]); 4] = [
    (
        "ttf-subsets-latin",
        include_bytes!("../../../fixtures/pdf-reader/files/ttf-subsets-latin.pdf"),
    ),
    (
        "ttf-subset-korean",
        include_bytes!("../../../fixtures/pdf-reader/files/ttf-subset-korean.pdf"),
    ),
    (
        "reportlab-truetype-subset",
        include_bytes!("../../../fixtures/pdf-reader/samples/reportlab-truetype-subset.pdf"),
    ),
    (
        "libreoffice-writer-report",
        include_bytes!("../../../fixtures/pdf-reader/samples/libreoffice-writer-report.pdf"),
    ),
];

#[test]
fn the_truetype_fonts_of_the_corpus_read_consistently() {
    let mut read = 0;
    for (name, pdf) in CORPUS_FONT_FILES {
        let fonts = embedded_truetype_fonts(pdf);
        assert!(!fonts.is_empty(), "{name} has TrueType fonts");
        for file in fonts {
            let font = TrueTypeFont::parse(&file, "Subset").expect("the table directory parses");
            for tag in ["head", "maxp"] {
                assert!(font.table(tag).is_some(), "{name}: {tag}");
            }
            let info = font.glyph_info(None).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(info.num_glyphs > 0, "{name}");
            let missing = info.missing_glyphs.as_ref().expect("glyf outlines");
            assert_eq!(missing.len(), usize::try_from(info.num_glyphs).unwrap());
            assert!(missing.iter().any(|missing| !missing), "{name}: some glyph has an outline");
            let metrics = font.metrics_override().unwrap();
            assert!(matches!(metrics.units_per_em, Some(units) if units > 0), "{name}");
            assert!(metrics.ascent_ratio().is_finite());
            let cmap = font.read_cmap_table(false, false).unwrap();
            let mappings = pairs(&cmap.mappings);
            assert!(
                mappings.windows(2).all(|pair| pair[0].0 < pair[1].0),
                "{name}: strictly ascending character codes"
            );
            if let Some(post) = font.read_post_script_table(info.num_glyphs)
                && let Some(names) = post.glyph_names
            {
                assert!(!names.is_empty(), "{name}");
            }
            if let Some(names) = font.read_name_table() {
                assert!(names.records.iter().all(|record| record.is_mac() || record.is_win()));
            }
            read += 1;
        }
    }
    assert!(read >= 8, "fonts read: {read}");
}
