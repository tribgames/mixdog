//! `Repair-ExcelPageSetupDpi`: a workbook written by a tool that leaves `horizontalDpi="0"` or `verticalDpi="0"` in a
//! sheet's page setup makes Excel's print preview fail, so before a background workbook is reopened its worksheets get 96.
//!
//! Only the `xl/worksheets/sheetN.xml` entries are read, and only an entry whose text changes is rewritten (as UTF-8 without
//! a byte order mark); every other entry of the package is copied as it is.

use std::io::Cursor;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;

use mixdog_fsio::WriteProof;
use regex::Regex;
use zip::CompressionMethod;
use zip::ZipArchive;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use super::Actions;
use super::file_error;
use crate::office::get_full_path;

/// An entry name decoded by its language-encoding flag (bit 11, which a valid Unicode Path field sets): UTF-8 with it,
/// CP437 without, as zip 2 read it. zip 9 reads any valid UTF-8 as UTF-8, so two distinct CP437 names could become one.
fn entry_name(raw: &[u8], flags: u16) -> String {
    if flags & (1 << 11) != 0 {
        String::from_utf8_lossy(raw).into_owned()
    } else {
        oem_cp::decode_string_complete_table(raw, &oem_cp::code_table::DECODING_TABLE_CP437)
    }
}

fn sheet_entry() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)^xl/worksheets/sheet\d+\.xml$").expect("the worksheet entry pattern is valid"))
}

fn dpi_attribute() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r#"\b(horizontalDpi|verticalDpi)="0""#).expect("the DPI attribute pattern is valid"))
}

/// What a `StreamReader` over UTF-8 with byte order mark detection reads of a part: the BOM chooses UTF-8, UTF-16 or UTF-32
/// and is dropped, and bytes that are not the encoding become U+FFFD.
fn decode(bytes: &[u8]) -> String {
    let words16 = |body: &[u8], big: bool| -> String {
        let units: Vec<u16> =
            body.chunks_exact(2).map(|pair| if big { u16::from_be_bytes([pair[0], pair[1]]) } else { u16::from_le_bytes([pair[0], pair[1]]) }).collect();
        String::from_utf16_lossy(&units)
    };
    let words32 = |body: &[u8], big: bool| -> String {
        body.chunks_exact(4)
            .map(|quad| {
                let word =
                    if big { u32::from_be_bytes([quad[0], quad[1], quad[2], quad[3]]) } else { u32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]]) };
                char::from_u32(word).unwrap_or(char::REPLACEMENT_CHARACTER)
            })
            .collect()
    };
    match bytes {
        [0xEF, 0xBB, 0xBF, body @ ..] => String::from_utf8_lossy(body).into_owned(),
        [0xFF, 0xFE, 0x00, 0x00, body @ ..] => words32(body, false),
        [0x00, 0x00, 0xFE, 0xFF, body @ ..] => words32(body, true),
        [0xFF, 0xFE, body @ ..] => words16(body, false),
        [0xFE, 0xFF, body @ ..] => words16(body, true),
        other => String::from_utf8_lossy(other).into_owned(),
    }
}

/// The package with every zero DPI of its worksheets set to 96, and how many entries changed. The package is returned as it
/// was (and the count is 0) when nothing needed repair.
pub fn repair_package(bytes: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let mut repaired: Vec<(usize, String)> = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if !sheet_entry().is_match(&entry_name(entry.name_raw(), entry.flags().as_u16())) {
            continue;
        }
        let mut raw = Vec::new();
        entry.read_to_end(&mut raw).map_err(|error| error.to_string())?;
        let xml = decode(&raw);
        let updated = dpi_attribute().replace_all(&xml, "${1}=\"96\"");
        if updated != xml {
            repaired.push((index, updated.into_owned()));
        }
    }
    if repaired.is_empty() {
        return Ok((bytes.to_vec(), 0));
    }
    let mut writer = ZipWriter::new(Cursor::new(Vec::with_capacity(bytes.len())));
    for index in 0..archive.len() {
        match repaired.iter().find(|(changed, _)| *changed == index) {
            Some((_, xml)) => {
                let entry = archive.by_index_raw(index).map_err(|error| error.to_string())?;
                let mut options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
                if let Some(stamp) = entry.last_modified() {
                    options = options.last_modified_time(stamp);
                }
                if let Some(mode) = entry.unix_mode() {
                    options = options.unix_permissions(mode);
                }
                writer.start_file(entry_name(entry.name_raw(), entry.flags().as_u16()), options).map_err(|error| error.to_string())?;
                writer.write_all(xml.as_bytes()).map_err(|error| error.to_string())?;
            }
            None => {
                let entry = archive.by_index_raw(index).map_err(|error| error.to_string())?;
                writer.raw_copy_file(entry).map_err(|error| error.to_string())?;
            }
        }
    }
    let rewritten = writer.finish().map_err(|error| error.to_string())?.into_inner();
    Ok((rewritten, repaired.len()))
}

/// `Repair-ExcelPageSetupDpi $path`: how many worksheet entries of the file at `path` were repaired. The file is opened
/// exclusively, so a workbook someone still holds is refused instead of changed under them, and is written back only when an
/// entry changed.
pub fn repair_excel_page_setup_dpi<P: WriteProof>(actions: &Actions<'_, P>, path: &str) -> Result<usize, String> {
    let full = get_full_path(path)?;
    let mut stream = actions.env.platform.open_exclusive(Path::new(&full)).map_err(|error| file_error("Open", 4, &full, &error))?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    let (repaired, changed) = repair_package(&bytes)?;
    // The exclusive handle has no way to shorten the file, so it is let go before the repaired package replaces the content.
    drop(stream);
    if changed > 0 {
        mixdog_fsio::write(actions.proof, &full, repaired).map_err(|error| file_error("Write", 1, &full, &error))?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(parts: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in parts {
            writer.start_file(*name, SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)).expect("entry");
            writer.write_all(content).expect("content");
        }
        writer.finish().expect("finish").into_inner()
    }

    fn content_of(bytes: &[u8], name: &str) -> String {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("a package");
        let mut text = String::new();
        archive.by_name(name).expect("entry").read_to_string(&mut text).expect("text");
        text
    }

    const ZERO: &str = r#"<worksheet><pageSetup horizontalDpi="0" verticalDpi="0" orientation="landscape"/></worksheet>"#;
    const FIXED: &str = r#"<worksheet><pageSetup horizontalDpi="96" verticalDpi="96" orientation="landscape"/></worksheet>"#;

    #[test]
    fn a_zero_dpi_in_a_worksheet_becomes_96_and_the_other_parts_keep_their_content() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("xl/worksheets/sheet1.xml", ZERO.as_bytes()),
            ("xl/worksheets/sheet2.xml", FIXED.as_bytes()),
            ("xl/worksheets/_rels/sheet1.xml.rels", ZERO.as_bytes()),
            ("xl/workbook.xml", b"<workbook horizontalDpi=\"0\"/>"),
        ]);
        let (repaired, changed) = repair_package(&bytes).expect("repaired");
        assert_eq!(changed, 1);
        assert_eq!(content_of(&repaired, "xl/worksheets/sheet1.xml"), FIXED);
        assert_eq!(content_of(&repaired, "xl/worksheets/sheet2.xml"), FIXED);
        assert_eq!(content_of(&repaired, "xl/worksheets/_rels/sheet1.xml.rels"), ZERO);
        assert_eq!(content_of(&repaired, "xl/workbook.xml"), "<workbook horizontalDpi=\"0\"/>");
        assert_eq!(content_of(&repaired, "[Content_Types].xml"), "<Types/>");
    }

    #[test]
    fn a_package_that_needs_nothing_is_returned_as_it_was() {
        let bytes = package(&[("xl/worksheets/sheet1.xml", FIXED.as_bytes())]);
        let (repaired, changed) = repair_package(&bytes).expect("checked");
        assert_eq!((changed, repaired), (0, bytes));
    }

    #[test]
    fn a_part_with_a_byte_order_mark_is_rewritten_without_one() {
        let mut part = vec![0xEF, 0xBB, 0xBF];
        part.extend_from_slice(ZERO.as_bytes());
        let (repaired, changed) = repair_package(&package(&[("XL/Worksheets/Sheet12.xml", &part)])).expect("repaired");
        assert_eq!(changed, 1);
        assert_eq!(content_of(&repaired, "XL/Worksheets/Sheet12.xml"), FIXED);
    }

    #[test]
    fn a_utf16_part_is_read_through_its_byte_order_mark() {
        let mut part = vec![0xFF, 0xFE];
        for unit in ZERO.encode_utf16() {
            part.extend_from_slice(&unit.to_le_bytes());
        }
        let (repaired, changed) = repair_package(&package(&[("xl/worksheets/sheet1.xml", &part)])).expect("repaired");
        assert_eq!(changed, 1);
        assert_eq!(content_of(&repaired, "xl/worksheets/sheet1.xml"), FIXED);
    }

    #[test]
    fn a_file_that_is_not_a_package_is_an_error() {
        assert!(repair_package(b"not a zip").is_err());
    }
}
