//! The stream filters of the reader: the text encodings, LZW and run length against known answers of the format,
//! Flate with its predictors, Brotli, the image codecs that leave their bytes alone, chains of filters in a page's
//! content, and the output limit.

use std::io::Write;

use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::{Dict, Obj, PdfError, StreamFilters};

use crate::read_support::{build, open, stream};

fn decode(name: &str, data: &[u8], params: Option<&Dict>) -> Vec<u8> {
    CodecFilters
        .decode(name, data, params, None, 1 << 20)
        .expect("decodes")
        .expect("a known filter")
}

fn flate(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).expect("writes");
    encoder.finish().expect("finishes")
}

fn parms(entries: &[(&str, f64)]) -> Dict {
    let mut dict = Dict::new();
    for (key, value) in entries {
        dict.set(key, Obj::Num(*value));
    }
    dict
}

#[test]
fn ascii_hex_ignores_white_space_and_pads_an_odd_last_digit() {
    assert_eq!(decode("ASCIIHexDecode", b"48 65 6C\n6c 6F>", None), b"Hello");
    assert_eq!(decode("AHx", b"7>", None), vec![0x70]);
    assert_eq!(decode("AHx", b"41>42", None), b"A", "nothing is read past the end marker");
}

#[test]
fn ascii85_groups_of_five_make_four_bytes_and_z_is_four_zeros() {
    assert_eq!(decode("ASCII85Decode", b"9jqo^~>", None), b"Man ");
    assert_eq!(decode("A85", b"z9jqo^~>", None), b"\0\0\0\0Man ");
}

#[test]
fn lzw_decodes_the_example_of_the_format() {
    // The worked example of the PDF specification: eleven bytes 45 45 45 45 45 65 45 45 45 66.
    let packed = [0x80, 0x0B, 0x60, 0x50, 0x22, 0x0C, 0x0C, 0x85, 0x01];
    assert_eq!(decode("LZWDecode", &packed, None), [45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
}

#[test]
fn run_length_copies_literals_repeats_runs_and_stops_at_the_end_marker() {
    // 2: three literal bytes follow; 253: the next byte four times (257 - 253); 128: end of data.
    let packed = [2, b'a', b'b', b'c', 253, b'x', 128, b'!', b'!'];
    assert_eq!(decode("RunLengthDecode", &packed, None), b"abcxxxx");
}

/// The PNG predictor rows of `rows`, one filter type per row (1 sub, 2 up, 3 average, 4 Paeth), as an encoder
/// writes them: each byte minus its prediction from the left (a), above (b) and upper left (c) neighbours.
fn png_encode(rows: &[Vec<u8>], kinds: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut above = vec![0u8; rows[0].len()];
    for (row, &kind) in rows.iter().zip(kinds) {
        out.push(kind);
        for i in 0..row.len() {
            let a = if i > 0 { row[i - 1] } else { 0 };
            let b = above[i];
            let c = if i > 0 { above[i - 1] } else { 0 };
            let predicted = match kind {
                1 => a,
                2 => b,
                3 => ((u16::from(a) + u16::from(b)) / 2) as u8,
                _ => {
                    let (pa, pb, pc) = (
                        (i32::from(b) - i32::from(c)).abs(),
                        (i32::from(a) - i32::from(c)).abs(),
                        (i32::from(a) + i32::from(b) - 2 * i32::from(c)).abs(),
                    );
                    if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    }
                }
            };
            out.push(row[i].wrapping_sub(predicted));
        }
        above = row.clone();
    }
    out
}

#[test]
fn flate_undoes_every_png_row_filter() {
    let rows = vec![
        vec![10, 20, 30, 40],
        vec![15, 25, 200, 41],
        vec![7, 250, 9, 255],
        vec![8, 249, 10, 1],
    ];
    let packed = flate(&png_encode(&rows, &[1, 2, 3, 4]));
    let params = parms(&[("Predictor", 15.0), ("Columns", 4.0)]);
    assert_eq!(decode("FlateDecode", &packed, Some(&params)), rows.concat());
}

#[test]
fn lzw_with_a_predictor_undoes_the_row_filter_too() {
    // Predictor 2 (TIFF) over RGB rows: each component is the difference from the pixel on its left. LZW with
    // 9-bit codes of literals only: 256 (clear), the bytes, 257 (end) is a valid stream while no table entry grows
    // past the code width, so the packed form is written here directly.
    let raw: [u8; 6] = [1, 2, 3, 1, 1, 1];
    let mut bits = String::new();
    for code in std::iter::once(256u16).chain(raw.iter().map(|&b| u16::from(b))).chain([257]) {
        bits.push_str(&format!("{code:09b}"));
    }
    while bits.len() % 8 != 0 {
        bits.push('0');
    }
    let packed: Vec<u8> = bits
        .as_bytes()
        .chunks(8)
        .map(|byte| u8::from_str_radix(std::str::from_utf8(byte).unwrap(), 2).unwrap())
        .collect();
    let params = parms(&[("Predictor", 2.0), ("Colors", 3.0), ("Columns", 2.0)]);
    assert_eq!(decode("LZWDecode", &packed, Some(&params)), [1, 2, 3, 2, 3, 4]);
}

#[test]
fn tiff_prediction_adds_the_pixel_on_the_left_per_component() {
    let params = parms(&[("Predictor", 2.0), ("Colors", 3.0), ("Columns", 3.0)]);
    let packed = flate(&[10, 20, 30, 1, 2, 3, 1, 2, 3, 100, 100, 100, 255, 0, 1, 0, 0, 0]);
    assert_eq!(
        decode("FlateDecode", &packed, Some(&params)),
        [10, 20, 30, 11, 22, 33, 12, 24, 36, 100, 100, 100, 99, 100, 101, 99, 100, 101]
    );
}

#[test]
fn brotli_decodes_and_stops_past_the_limit() {
    let data: Vec<u8> = (0..4000u32).map(|n| (n % 251) as u8).collect();
    let mut packed = Vec::new();
    brotli::BrotliCompress(&mut &data[..], &mut packed, &brotli::enc::BrotliEncoderParams::default())
        .expect("compresses");
    assert_eq!(decode("BrotliDecode", &packed, None), data);
    assert!(matches!(
        CodecFilters.decode("BrotliDecode", &packed, None, None, 100),
        Err(PdfError::ResourceLimit(_))
    ));
}

#[test]
fn flate_output_past_the_limit_is_refused() {
    let packed = flate(&vec![0u8; 10_000]);
    assert!(matches!(
        CodecFilters.decode("FlateDecode", &packed, None, None, 100),
        Err(PdfError::ResourceLimit(_))
    ));
    assert_eq!(decode("FlateDecode", &packed, None).len(), 10_000);
}

#[test]
fn image_codecs_keep_their_bytes_and_an_unknown_filter_is_not_decoded() {
    for name in ["DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode"] {
        assert_eq!(decode(name, b"pixels", None), b"pixels", "{name}");
    }
    assert!(matches!(CodecFilters.decode("NoSuchDecode", b"x", None, None, 100), Ok(None)));
}

#[test]
fn a_page_content_runs_through_its_whole_filter_chain() {
    let text = "BT /F1 12 Tf 20 100 Td (chained) Tj ET";
    let hex: String = flate(text.as_bytes()).iter().map(|b| format!("{b:02X}")).collect();
    let objects: Vec<(u32, Vec<u8>)> = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>".to_vec()),
        (4, stream("/Filter [/ASCIIHexDecode /FlateDecode]", format!("{hex}>").as_bytes())),
    ];
    let document = open(build(&objects));
    let content = document.page(0).expect("a page").content(&document).expect("the content");
    assert_eq!(content, text.as_bytes());
}
