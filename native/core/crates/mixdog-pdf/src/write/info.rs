//! The document information dictionary (`/Info` of the trailer): `Title`, `Author`, `Subject`, `Keywords` and
//! `Creator` as text strings (UTF-16BE with a byte order mark, as pdf-lib's `PDFHexString.fromText` writes them), the
//! metadata a freshly created document gets, and `applyDocumentProperties` of the office PDF writer.
//!
//! A document loaded for editing never has its metadata touched (the office code loads with `updateMetadata: false`):
//! `Producer` and the dates are left as the file has them.

use std::sync::Arc;

use crate::object::{Dict, Obj, Ref};
use crate::write::PdfDocument;

/// What a document made here names itself in `Producer` and, when it has none, in `Creator`.
pub const PRODUCER: &str = "Mixdog";

/// The properties a caller may set in one go (`applyDocumentProperties`): an absent one leaves the entry alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentProperties {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    /// Joined with a space into the one `Keywords` string (`keywords.join(' ')`).
    pub keywords: Option<Vec<String>>,
}

/// pdf-lib's `PDFHexString.fromText`: the byte order mark and the UTF-16 code units, big-endian.
pub fn encode_text_string(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xfe, 0xff];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    bytes
}

/// PDFDocEncoding where it differs from Latin-1 (`pdfDocEncodingToUnicode`).
fn pdf_doc_char(byte: u8) -> char {
    match byte {
        0x16 => '\u{0017}',
        0x18 => '\u{02D8}',
        0x19 => '\u{02C7}',
        0x1a => '\u{02C6}',
        0x1b => '\u{02D9}',
        0x1c => '\u{02DD}',
        0x1d => '\u{02DB}',
        0x1e => '\u{02DA}',
        0x1f => '\u{02DC}',
        0x7f | 0x9f | 0xad => '\u{FFFD}',
        0x80 => '\u{2022}',
        0x81 => '\u{2020}',
        0x82 => '\u{2021}',
        0x83 => '\u{2026}',
        0x84 => '\u{2014}',
        0x85 => '\u{2013}',
        0x86 => '\u{0192}',
        0x87 => '\u{2044}',
        0x88 => '\u{2039}',
        0x89 => '\u{203A}',
        0x8a => '\u{2212}',
        0x8b => '\u{2030}',
        0x8c => '\u{201E}',
        0x8d => '\u{201C}',
        0x8e => '\u{201D}',
        0x8f => '\u{2018}',
        0x90 => '\u{2019}',
        0x91 => '\u{201A}',
        0x92 => '\u{2122}',
        0x93 => '\u{FB01}',
        0x94 => '\u{FB02}',
        0x95 => '\u{0141}',
        0x96 => '\u{0152}',
        0x97 => '\u{0160}',
        0x98 => '\u{0178}',
        0x99 => '\u{017D}',
        0x9a => '\u{0131}',
        0x9b => '\u{0142}',
        0x9c => '\u{0153}',
        0x9d => '\u{0161}',
        0x9e => '\u{017E}',
        0xa0 => '\u{20AC}',
        other => char::from(other),
    }
}

/// pdf-lib's `decodeText`: UTF-16 when the bytes start with a byte order mark (big-endian `FE FF` or little-endian
/// `FF FE`), else PDFDocEncoding. As pdf-lib's `utf16Decode`: a high surrogate takes the next unit with it whatever
/// it is, a unit that does not pair is U+FFFD, and so is an odd byte at the end.
pub fn decode_text_string(bytes: &[u8]) -> String {
    let little_endian = match bytes {
        [0xfe, 0xff, ..] => false,
        [0xff, 0xfe, ..] => true,
        _ => return bytes.iter().map(|b| pdf_doc_char(*b)).collect(),
    };
    let body = &bytes[2..];
    let units: Vec<u16> =
        body.chunks_exact(2).map(|pair| if little_endian { u16::from_le_bytes([pair[0], pair[1]]) } else { u16::from_be_bytes([pair[0], pair[1]]) }).collect();
    let mut text = String::with_capacity(units.len());
    let mut at = 0;
    while at < units.len() {
        let first = units[at];
        at += 1;
        let decoded = match first {
            0xd800..=0xdbff => match units.get(at) {
                Some(&second) => {
                    at += 1;
                    char::decode_utf16([first, second]).next().and_then(Result::ok)
                }
                None => None,
            },
            0xdc00..=0xdfff => None,
            _ => char::from_u32(u32::from(first)),
        };
        text.push(decoded.unwrap_or(char::REPLACEMENT_CHARACTER));
    }
    if body.len() % 2 == 1 {
        text.push(char::REPLACEMENT_CHARACTER);
    }
    text
}

/// `PDFString.fromDate`: `D:YYYYMMDDHHmmSSZ` in UTC, for a time in seconds since the Unix epoch.
pub fn pdf_date(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let secs = unix_seconds.rem_euclid(86_400);
    // Days since 1970-01-01 to a civil date (the days-from-civil inverse, with years counted from March).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("D:{year:04}{month:02}{day:02}{:02}{:02}{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

impl PdfDocument {
    /// `getInfoDict`: the `Info` dictionary, made (and named in the trailer) when the file has none.
    pub fn info_ref(&mut self) -> Ref {
        if let Some(existing) = self.store.trailer.info
            && matches!(self.store.resolve(&Obj::Ref(existing)), Some(Obj::Dict(_)))
        {
            return existing;
        }
        let made = self.store.register(Obj::Dict(Arc::new(Dict::new())));
        self.store.trailer.info = Some(made);
        made
    }

    fn set_info_text(&mut self, key: &str, text: &str) {
        let info = self.info_ref();
        let value = Obj::Str(Arc::from(encode_text_string(text)));
        self.store.modify_dict(info, |dict| dict.set(key, value));
    }

    fn info_text(&self, key: &str) -> Option<String> {
        let info = self.store.trailer.info?;
        let dict = self.store.dict(info)?;
        match self.store.lookup(dict, key)? {
            Obj::Str(bytes) => Some(decode_text_string(bytes)),
            _ => None,
        }
    }

    pub fn set_title(&mut self, title: &str) {
        self.set_info_text("Title", title);
    }

    pub fn set_author(&mut self, author: &str) {
        self.set_info_text("Author", author);
    }

    pub fn set_subject(&mut self, subject: &str) {
        self.set_info_text("Subject", subject);
    }

    pub fn set_creator(&mut self, creator: &str) {
        self.set_info_text("Creator", creator);
    }

    pub fn set_producer(&mut self, producer: &str) {
        self.set_info_text("Producer", producer);
    }

    /// `setKeywords`: the keywords joined with a space.
    pub fn set_keywords(&mut self, keywords: &[String]) {
        self.set_info_text("Keywords", &keywords.join(" "));
    }

    pub fn title(&self) -> Option<String> {
        self.info_text("Title")
    }

    pub fn author(&self) -> Option<String> {
        self.info_text("Author")
    }

    pub fn subject(&self) -> Option<String> {
        self.info_text("Subject")
    }

    pub fn keywords(&self) -> Option<String> {
        self.info_text("Keywords")
    }

    pub fn creator(&self) -> Option<String> {
        self.info_text("Creator")
    }

    pub fn producer(&self) -> Option<String> {
        self.info_text("Producer")
    }

    /// `applyDocumentProperties` of `pdf/pdf-writer.mjs`.
    pub fn apply_document_properties(&mut self, properties: &DocumentProperties) {
        if let Some(title) = &properties.title {
            self.set_title(title);
        }
        if let Some(author) = &properties.author {
            self.set_author(author);
        }
        if let Some(subject) = &properties.subject {
            self.set_subject(subject);
        }
        if let Some(keywords) = &properties.keywords {
            self.set_keywords(keywords);
        }
    }

    /// `updateInfoDict`, run when a document is created: `Producer`, `ModDate`, and `Creator` and `CreationDate`
    /// when the dictionary has none.
    pub(crate) fn update_info_dict(&mut self, now_unix_seconds: i64) {
        let info = self.info_ref();
        self.set_producer(PRODUCER);
        let date = Obj::Str(Arc::from(pdf_date(now_unix_seconds).into_bytes()));
        let has =
            |store: &crate::write::store::ObjectStore, key: &str| store.dict(info).is_some_and(|dict| dict.get_raw(key).is_some_and(|value| !value.is_null()));
        let needs_creator = !has(&self.store, "Creator");
        let needs_created = !has(&self.store, "CreationDate");
        self.store.modify_dict(info, |dict| {
            dict.set("ModDate", date.clone());
            if needs_created {
                dict.set("CreationDate", date);
            }
        });
        if needs_creator {
            self.set_creator(PRODUCER);
        }
    }
}
