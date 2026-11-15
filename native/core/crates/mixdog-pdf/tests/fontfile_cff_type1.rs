//! The CFF and Type 1 font-program readers against pdf.js 6.4.299.
//!
//! The twin cases (`fontfile_cff_type1/cases.rs`, recorded by `fontfile_cff_type1/record.mjs`) are font programs
//! built for every table the readers branch on, with what pdf.js reads from each rendered as text; this file renders
//! what the Rust readers read in the same form and compares the two. The remaining tests check the two embedded
//! Foxit programs against the Adobe core font metrics (code to glyph name to width) and the places where this port
//! deliberately differs from pdf.js.

#[path = "fontfile_cff_type1/cases.rs"]
mod cases;

use std::collections::BTreeMap;

use cases::{CFF_CASES, TYPE1_CASES};
use mixdog_pdf::error::PdfError;
use mixdog_pdf::fontfile::cff::{
    Cff, CffProperties, CharsetEntry, read_cff_font, read_standard_font, standard_font_data,
};
use mixdog_pdf::fontfile::type1::{Type1Font, Type1Properties};
use mixdog_pdf::fonts::data::encodings::{SYMBOL_SET_ENCODING, ZAPF_DINGBATS_ENCODING};

// ---- rendering in the form of record.mjs --------------------------------------------------------------------------

fn num(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_owned()
    } else if n == 0.0 {
        "0".to_owned()
    } else {
        n.to_string()
    }
}

fn list(values: &[f64]) -> String {
    values.iter().map(|&v| num(v)).collect::<Vec<_>>().join(",")
}

fn optional(value: Option<f64>) -> String {
    value.map_or_else(|| "undefined".to_owned(), num)
}

fn seacs(map: &BTreeMap<usize, Vec<f64>>) -> String {
    map.iter()
        .map(|(g, s)| format!("{g}:{}", list(s)))
        .collect::<Vec<_>>()
        .join(";")
}

fn built_in(map: Option<&BTreeMap<u32, String>>) -> String {
    match map {
        Some(map) => format!(
            "builtIn={}",
            map.iter()
                .map(|(c, n)| format!("{c}:{n}"))
                .collect::<Vec<_>>()
                .join(",")
        ),
        None => "builtIn=none".to_owned(),
    }
}

fn error_line(error: &PdfError) -> String {
    match error {
        PdfError::Format(message) => format!("error=FormatError: {message}"),
        PdfError::Unknown(message) => {
            format!("error={}", message.split(':').next().unwrap_or(message))
        }
        other => format!("error={other:?}"),
    }
}

/// The lines of an expected text that are inputs (`#name=value`).
fn inputs(expected: &str) -> BTreeMap<&str, &str> {
    expected
        .lines()
        .filter_map(|l| l.strip_prefix('#'))
        .filter_map(|l| l.split_once('='))
        .collect()
}

fn numbers(text: &str) -> Vec<f64> {
    text.split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().unwrap())
        .collect()
}

fn render_cff(data: &[u8], bbox: Option<Vec<f64>>) -> Vec<String> {
    let mut properties = CffProperties {
        bbox,
        ..Default::default()
    };
    let cff = match read_cff_font(data, &mut properties) {
        Ok(cff) => cff,
        Err(e) => return vec![error_line(&e)],
    };
    let mut out = Vec::new();
    out.push(format!("isCID={}", cff.is_cid_font));
    out.push(format!("names={}", cff.names.join(",")));
    let num_glyphs = cff.char_strings.count();
    out.push(format!("numGlyphs={num_glyphs}"));
    out.push(format!("charStringCount={}", cff.char_string_count));
    let charset: Vec<String> = cff
        .charset
        .charset
        .iter()
        .map(|c| match c {
            CharsetEntry::Cid(n) => n.to_string(),
            CharsetEntry::Name(Some(name)) => name.clone(),
            CharsetEntry::Name(None) => "undefined".to_owned(),
        })
        .collect();
    out.push(format!("charset={}", charset.join(",")));
    out.push(format!(
        "charsetFormat={}{}",
        if cff.charset.predefined {
            "predefined"
        } else {
            "custom"
        },
        cff.charset.format
    ));
    match &cff.encoding {
        Some(encoding) => {
            out.push(format!(
                "encoding={}",
                encoding
                    .encoding
                    .iter()
                    .map(|(c, g)| format!("{c}:{g}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
            out.push(format!(
                "encodingFormat={}{}",
                if encoding.predefined {
                    "predefined"
                } else {
                    "custom"
                },
                encoding.format
            ));
        }
        None => out.push("encoding=none".to_owned()),
    }
    out.push(built_in(properties.built_in_encoding.as_ref()));
    out.push(format!("widths={}", list(&cff.widths)));
    out.push(format!("seacs={}", seacs(&cff.seacs)));
    let private = |d: &mixdog_pdf::fontfile::cff::CffDict| {
        let p = d.private_dict.as_ref().expect("a private dictionary");
        format!(
            "{}/{}",
            optional(p.number("defaultWidthX")),
            optional(p.number("nominalWidthX"))
        )
    };
    out.push(format!("topPrivate={}", private(&cff.top_dict)));
    out.push(format!(
        "fdArray={}",
        cff.fd_array
            .iter()
            .map(private)
            .collect::<Vec<_>>()
            .join(";")
    ));
    out.push(match &cff.fd_select {
        Some(select) => format!(
            "fdSelect={}",
            select
                .entries()
                .iter()
                .map(|e| e.map_or_else(String::new, |v| v.to_string()))
                .collect::<Vec<_>>()
                .join(",")
        ),
        None => "fdSelect=none".to_owned(),
    });
    out.push(match &properties.font_matrix {
        Some(m) => format!("fontMatrix={}", list(m)),
        None => "fontMatrix=none".to_owned(),
    });
    out.push(format!(
        "fontBBox={}",
        list(&cff.top_dict.list("FontBBox").unwrap_or_default())
    ));
    out.push(format!("ascent={}", optional(properties.ascent)));
    out.push(format!("descent={}", optional(properties.descent)));
    out.push(format!(
        "hasGlyph={}",
        (0..=num_glyphs as i64)
            .map(|i| if cff.has_glyph_id(i) { "1" } else { "0" })
            .collect::<String>()
    ));
    out
}

fn render_type1(data: &[u8], input: &BTreeMap<&str, &str>) -> Vec<String> {
    let mut properties = Type1Properties {
        length1: input.get("length1").and_then(|v| v.parse().ok()),
        composite: input["composite"] == "true",
        first_char: input["firstChar"].parse().unwrap(),
        last_char: input["lastChar"].parse().unwrap(),
        font_matrix: Some(vec![0.001, 0.0, 0.0, 0.001, 0.0, 0.0]),
        ..Default::default()
    };
    for entry in input["widths"].split(',').filter(|s| !s.is_empty()) {
        let (code, width) = entry.split_once(':').unwrap();
        properties
            .widths
            .insert(code.parse().unwrap(), width.parse().unwrap());
    }
    let font = match Type1Font::parse(data, &mut properties) {
        Ok(font) => font,
        Err(e) => return vec![error_line(&e)],
    };
    let mut out = Vec::new();
    out.push(format!("numGlyphs={}", font.num_glyphs()));
    out.push(format!(
        "charset={}",
        font.charset()
            .into_iter()
            .map(|n| n.unwrap_or_else(|| "null".to_owned()))
            .collect::<Vec<_>>()
            .join(",")
    ));
    out.push(format!(
        "glyphs={}",
        font.charstrings
            .iter()
            .enumerate()
            .map(|(i, g)| format!(
                "{}:{}:{}:{}",
                g.glyph_name.as_deref().unwrap_or("null"),
                num(g.width),
                num(g.lsb),
                u8::from(font.has_glyph_id(i as i64 + 1))
            ))
            .collect::<Vec<_>>()
            .join(";")
    ));
    out.push(format!("seacs={}", seacs(&font.seacs)));
    out.push(built_in(properties.built_in_encoding.as_ref()));
    out.push(format!(
        "widths={}",
        properties
            .widths
            .iter()
            .map(|(c, w)| format!("{c}:{}", num(*w)))
            .collect::<Vec<_>>()
            .join(",")
    ));
    out.push(match &properties.font_matrix {
        Some(m) => format!("fontMatrix={}", list(m)),
        None => "fontMatrix=none".to_owned(),
    });
    out.push(format!("ascent={}", optional(properties.ascent)));
    out.push(format!("descent={}", optional(properties.descent)));
    out.push(format!(
        "hasGlyph={}",
        (0..=font.num_glyphs() as i64)
            .map(|i| if font.has_glyph_id(i) { "1" } else { "0" })
            .collect::<String>()
    ));
    out
}

/// The expected text without its input lines.
fn expected_lines(expected: &str) -> Vec<&str> {
    expected.lines().filter(|l| !l.starts_with('#')).collect()
}

// ---- twin cases ---------------------------------------------------------------------------------------------------

#[test]
fn cff_cases_read_as_pdfjs_reads_them() {
    assert!(CFF_CASES.len() >= 16);
    for (name, data, expected) in CFF_CASES {
        let input = inputs(expected);
        let bbox = match input["bbox"] {
            "none" => None,
            list => Some(numbers(list)),
        };
        let got = render_cff(data, bbox);
        assert_eq!(got, expected_lines(expected), "CFF case {name}");
    }
}

#[test]
fn type1_cases_read_as_pdfjs_reads_them() {
    assert!(TYPE1_CASES.len() >= 16);
    for (name, data, expected) in TYPE1_CASES {
        let got = render_type1(data, &inputs(expected));
        assert_eq!(got, expected_lines(expected), "Type 1 case {name}");
    }
}

fn case<'a>(cases: &'a [(&str, &'a [u8], &str)], name: &str) -> &'a [u8] {
    cases
        .iter()
        .find(|(n, _, _)| *n == name)
        .unwrap_or_else(|| panic!("no case {name}"))
        .1
}

// ---- the standard fonts -------------------------------------------------------------------------------------------

/// Width of the glyph `code` selects in a font read as an internal standard font (pdf.js maps the code through the
/// font's default encoding, then the name through the program's charset).
fn width_of(cff: &Cff, encoding: &[&str; 256], code: usize) -> Option<f64> {
    let name = encoding[code];
    let glyph = cff
        .charset
        .charset
        .iter()
        .position(|e| matches!(e, CharsetEntry::Name(Some(n)) if n == name))?;
    cff.widths.get(glyph).copied()
}

#[test]
fn only_symbol_and_zapfdingbats_have_standard_font_data() {
    assert!(standard_font_data("Symbol").is_some());
    assert!(standard_font_data("ZapfDingbats").is_some());
    for name in ["Helvetica", "Times-Roman", "Courier", "Arial", ""] {
        assert!(standard_font_data(name).is_none(), "{name}");
        assert!(read_standard_font(name, &mut CffProperties::default()).is_none());
    }
}

#[test]
fn symbol_code_to_glyph_to_width() {
    let mut properties = CffProperties::default();
    let cff = read_standard_font("Symbol", &mut properties)
        .expect("a program")
        .expect("a font");
    // The Adobe Symbol core font metrics: space, universal, Alpha, Beta, alpha, beta, chi, phi.
    for (code, width) in [
        (0x20, 250.0),
        (0x22, 713.0),
        (0x41, 722.0),
        (0x42, 667.0),
        (0x61, 631.0),
        (0x62, 549.0),
        (0x63, 549.0),
        (0x66, 521.0),
    ] {
        assert_eq!(
            width_of(&cff, &SYMBOL_SET_ENCODING, code),
            Some(width),
            "Symbol code {code:#x}"
        );
    }
    assert_eq!(cff.char_strings.count(), cff.char_string_count + 1);
    assert!(properties.built_in_encoding.is_some());
}

#[test]
fn zapfdingbats_code_to_glyph_to_width() {
    let mut properties = CffProperties::default();
    let cff = read_standard_font("ZapfDingbats", &mut properties)
        .expect("a program")
        .expect("a font");
    // The Adobe ZapfDingbats core font metrics: space, a1, a2, a202, a3, a4, a5.
    for (code, width) in [
        (0x20, 278.0),
        (0x21, 974.0),
        (0x22, 961.0),
        (0x23, 974.0),
        (0x24, 980.0),
        (0x25, 719.0),
        (0x26, 789.0),
    ] {
        assert_eq!(
            width_of(&cff, &ZAPF_DINGBATS_ENCODING, code),
            Some(width),
            "ZapfDingbats code {code:#x}"
        );
    }
}

// ---- the readers' interfaces --------------------------------------------------------------------------------------

#[test]
fn cff_composite_glyph_mapping_follows_the_charset_of_a_cid_font() {
    let mut properties = CffProperties::default();
    let cff = read_cff_font(case(CFF_CASES, "cff-cid-fdselect3"), &mut properties).unwrap();
    // charset 0,1,2,3,10,11 at glyph ids 0..5.
    let map = cff.composite_glyph_mapping(|cid| i64::from(cid) + 100, None);
    assert_eq!(
        map.into_iter().collect::<Vec<_>>(),
        vec![(100, 0), (101, 1), (102, 2), (103, 3), (110, 4), (111, 5)]
    );
    // A CIDToGIDMap that sends cid 1 to glyph 101 is inverted: the character code 101 (of cid 1) becomes 1.
    let cid_to_gid = BTreeMap::from([(1_i64, 101_i64)]);
    let map = cff.composite_glyph_mapping(|cid| i64::from(cid) + 100, Some(&cid_to_gid));
    assert_eq!(map.get(&1), Some(&1));
    assert_eq!(map.get(&101), None);
}

#[test]
fn cff_glyph_ids_beyond_the_program_are_absent() {
    let mut properties = CffProperties::default();
    let cff = read_cff_font(case(CFF_CASES, "cff-basic-predefined"), &mut properties).unwrap();
    assert!(cff.has_glyph_id(0));
    assert!(!cff.has_glyph_id(-1));
    assert!(!cff.has_glyph_id(cff.char_strings.count() as i64));
    // The empty charstring has no glyph; glyph 0 is duplicated at the end.
    assert!(!cff.has_glyph_id(13));
    assert_eq!(cff.char_strings.count(), 17);
}

#[test]
fn type1_glyph_mapping_helpers() {
    let data = case(TYPE1_CASES, "t1-raw-binary");
    let mut properties = Type1Properties {
        length1: Some(351.0),
        first_char: 0,
        last_char: 255,
        ..Default::default()
    };
    let font = Type1Font::parse(data, &mut properties).unwrap();
    let ids = font.built_in_glyph_ids(&properties).unwrap();
    // .notdef is glyph 0 and is the first charstring; A is glyph id 2, B 3, C 4, a 5.
    assert_eq!(
        ids.into_iter().collect::<Vec<_>>(),
        vec![(50, 4), (65, 2), (66, 3), (97, 5)]
    );
    let map = font.composite_glyph_mapping(|glyph| i64::from(glyph) * 2);
    assert_eq!(map.get(&0), Some(&1));
    assert_eq!(map.get(&2), Some(&2));
    assert_eq!(map.len(), font.charstrings.len());
    assert!(font.has_glyph_id(0));
    assert!(!font.has_glyph_id(font.num_glyphs() as i64));
    assert!(!font.has_glyph_id(-1));
}

// ---- where this port differs from pdf.js --------------------------------------------------------------------------

#[test]
fn a_charset_that_ends_inside_its_ranges_is_an_error_where_pdfjs_loops_for_ever() {
    let font = case(CFF_CASES, "cff-charset1-encoding1");
    // The Top DICT's `charset` operand is `29 <int32> 15`: point it at three bytes appended to the file (format 1,
    // one range start, and no count).
    let operator = font
        .windows(6)
        .position(|w| w[0] == 29 && w[5] == 15)
        .expect("the charset operator");
    let mut patched = font.to_vec();
    let at = patched.len() as u32;
    patched[operator + 1..operator + 5].copy_from_slice(&at.to_be_bytes());
    patched.extend_from_slice(&[1, 0, 34]);
    let error = read_cff_font(&patched, &mut CffProperties::default()).unwrap_err();
    assert_eq!(
        error,
        PdfError::Format("CFF charset ends inside its ranges".to_owned())
    );
}

#[test]
fn a_font_with_no_cff_header_is_a_format_error() {
    let error = read_cff_font(&[0, 0, 0, 0], &mut CffProperties::default()).unwrap_err();
    assert_eq!(error, PdfError::Format("Invalid CFF header".to_owned()));
    let error = read_cff_font(&[], &mut CffProperties::default()).unwrap_err();
    assert_eq!(error, PdfError::Format("Invalid CFF header".to_owned()));
}

#[test]
fn a_type1_file_without_a_font_program_is_a_format_error() {
    let error =
        Type1Font::parse(b"%!PS-AdobeFont-1.0\n", &mut Type1Properties::default()).unwrap_err();
    assert_eq!(
        error,
        PdfError::Format("getEexecBlock - no font program found.".to_owned())
    );
}
