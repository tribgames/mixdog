//! The ZIP container of an Office package: the central directory and the entries' content, as Node's
//! `zipCentralDirectory` and `zipEntryContent` read them (stored and raw-deflate entries only, every inflated size capped).

use std::cell::Cell;
use std::collections::HashMap;

use flate2::Decompress;
use flate2::FlushDecompress;
use flate2::Status;

use crate::Failure;
use crate::Limits;

/// A crafted container can inflate a few KB into gigabytes. Every entry is capped on its own...
pub const PART_MAX_INFLATED_BYTES: u64 = 32 * 1024 * 1024;
/// ...and all entries of one container share a total budget.
pub const CONTAINER_MAX_INFLATED_BYTES: u64 = 128 * 1024 * 1024;

const EOCD_SIG: u32 = 0x0605_4b50; // end of central directory
const CDIR_SIG: u32 = 0x0201_4b50; // central directory file header
const LOCAL_SIG: u32 = 0x0403_4b50; // local file header

struct Entry {
    name: String,
    method: u16,
    start: usize,
    end: usize,
}

/// The central directory of `buf`, entries by name in the order a name was first seen (a later entry of the same name
/// replaces the earlier one in place, as `Map.set` does).
pub struct Zip<'a> {
    buf: &'a [u8],
    entries: Vec<Entry>,
    by_name: HashMap<String, usize>,
    /// What all entries together may still inflate to.
    remaining: Cell<u64>,
    max_part_bytes: u64,
}

fn u16_at(buf: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([buf[at], buf[at + 1]])
}

fn u32_at(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
}

/// `buf.toString('utf8', ..)`: invalid sequences become U+FFFD.
pub fn utf8_text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

impl<'a> Zip<'a> {
    /// `zipCentralDirectory(buf, limits)`.
    pub fn open(buf: &'a [u8], limits: &Limits) -> Result<Self, Failure> {
        // EOCD is at most 22 + 65535 (comment) bytes from the end.
        let mut eocd = None;
        if buf.len() >= 22 {
            let scan_from = buf.len().saturating_sub(22 + 65535);
            let mut i = buf.len() - 22;
            loop {
                if u32_at(buf, i) == EOCD_SIG {
                    eocd = Some(i);
                    break;
                }
                if i == scan_from {
                    break;
                }
                i -= 1;
            }
        }
        let Some(eocd) = eocd else {
            return Err(Failure::Other("not a ZIP container (no end-of-central-directory record)".into()));
        };
        let count = u16_at(buf, eocd + 10);
        let mut off = u64::from(u32_at(buf, eocd + 16));
        let max_container = if limits.max_container_bytes == 0 {
            CONTAINER_MAX_INFLATED_BYTES
        } else {
            CONTAINER_MAX_INFLATED_BYTES.min(limits.max_container_bytes)
        };
        let max_part_bytes = if limits.max_part_bytes == 0 {
            PART_MAX_INFLATED_BYTES
        } else {
            PART_MAX_INFLATED_BYTES.min(limits.max_part_bytes)
        };
        let mut zip = Zip {
            buf,
            entries: Vec::new(),
            by_name: HashMap::new(),
            remaining: Cell::new(max_container),
            max_part_bytes,
        };
        let len = buf.len() as u64;
        for _ in 0..count {
            if off + 46 > len || u32_at(buf, off as usize) != CDIR_SIG {
                break;
            }
            let head = off as usize;
            let method = u16_at(buf, head + 10);
            let compressed_size = u64::from(u32_at(buf, head + 20));
            let name_len = usize::from(u16_at(buf, head + 28));
            let extra_len = u64::from(u16_at(buf, head + 30));
            let comment_len = u64::from(u16_at(buf, head + 32));
            let local_off = u64::from(u32_at(buf, head + 42));
            let name_end = (head + 46 + name_len).min(buf.len());
            let name = utf8_text(buf[head + 46..name_end].to_vec());
            // The data offset needs the LOCAL header's name/extra lengths (they can differ from the central copy).
            if local_off + 30 <= len && u32_at(buf, local_off as usize) == LOCAL_SIG {
                let local = local_off as usize;
                let start = local_off + 30 + u64::from(u16_at(buf, local + 26)) + u64::from(u16_at(buf, local + 28));
                let entry = Entry {
                    name: name.clone(),
                    method,
                    start: usize::try_from(start).unwrap_or(usize::MAX),
                    end: usize::try_from(start + compressed_size).unwrap_or(usize::MAX),
                };
                match zip.by_name.get(&name) {
                    Some(&at) => zip.entries[at] = entry,
                    None => {
                        zip.by_name.insert(name, zip.entries.len());
                        zip.entries.push(entry);
                    }
                }
            }
            off += 46 + name_len as u64 + extra_len + comment_len;
        }
        Ok(zip)
    }

    pub fn has(&self, name: &str) -> bool {
        self.by_name.contains_key(name)
    }

    /// The entry names in insertion order (`[...entries.keys()]`).
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|entry| entry.name.as_str())
    }

    /// `zipEntryContent`: the entry's bytes, stored or inflated within the part cap and what is left of the container's.
    pub fn content(&self, name: &str) -> Option<Result<Vec<u8>, Failure>> {
        let entry = &self.entries[*self.by_name.get(name)?];
        Some(self.entry_content(entry))
    }

    /// `partText(buf, entries, name)`: the part as text, or empty when it is absent (or `name` is empty).
    pub fn part_text(&self, name: &str) -> Result<String, Failure> {
        if name.is_empty() {
            return Ok(String::new());
        }
        match self.content(name) {
            Some(content) => content.map(utf8_text),
            None => Ok(String::new()),
        }
    }

    fn entry_content(&self, entry: &Entry) -> Result<Vec<u8>, Failure> {
        let start = entry.start.min(self.buf.len());
        let end = entry.end.min(self.buf.len()).max(start);
        let raw = &self.buf[start..end];
        if entry.method == 0 {
            // stored: not counted against the container's budget
            if raw.len() as u64 > self.max_part_bytes {
                return Err(Failure::Other(format!(
                    "zip entry {} is too large when decompressed (limit {} bytes)",
                    entry.name, self.max_part_bytes
                )));
            }
            return Ok(raw.to_vec());
        }
        if entry.method != 8 {
            return Err(Failure::Other(format!("unsupported ZIP compression method {}", entry.method)));
        }
        let limit = self.max_part_bytes.min(self.remaining.get());
        let out = inflate_raw(raw, limit.max(1)).map_err(|error| match error {
            Inflate::TooLarge => Failure::Other(format!(
                "zip entry {} is too large when decompressed (limit {limit} bytes)",
                entry.name
            )),
            Inflate::Broken(message) => Failure::Other(message),
        })?;
        self.remaining.set(self.remaining.get().saturating_sub(out.len() as u64));
        Ok(out)
    }
}

enum Inflate {
    /// Node's `ERR_BUFFER_TOO_LARGE`.
    TooLarge,
    /// zlib's own message (`unexpected end of file`, `invalid block type`, ..).
    Broken(String),
}

/// `inflateRawSync(raw, { maxOutputLength })`: the whole stream (bytes after its end are ignored), failing when it
/// inflates to more than `max_output` bytes, ends early or is corrupt.
fn inflate_raw(raw: &[u8], max_output: u64) -> Result<Vec<u8>, Inflate> {
    let mut stream = Decompress::new(false);
    let mut out: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 32 * 1024];
    loop {
        let consumed = usize::try_from(stream.total_in()).unwrap_or(usize::MAX).min(raw.len());
        let before = stream.total_out();
        let status = stream
            .decompress(&raw[consumed..], &mut chunk, FlushDecompress::None)
            .map_err(|error| Inflate::Broken(error.message().unwrap_or("invalid data").to_owned()))?;
        let produced = usize::try_from(stream.total_out() - before).unwrap_or(0);
        if (out.len() + produced) as u64 > max_output {
            return Err(Inflate::TooLarge);
        }
        out.extend_from_slice(&chunk[..produced]);
        if status == Status::StreamEnd {
            return Ok(out);
        }
        // No progress: the input ran out before the stream ended.
        let read = usize::try_from(stream.total_in()).unwrap_or(usize::MAX);
        if produced == 0 && read == consumed {
            return Err(Inflate::Broken("unexpected end of file".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One final stored block holding `abc`.
    const STORED_ABC: [u8; 8] = [0x01, 0x03, 0x00, 0xfc, 0xff, b'a', b'b', b'c'];

    fn inflated(raw: &[u8], max: u64) -> Result<Vec<u8>, String> {
        inflate_raw(raw, max).map_err(|error| match error {
            Inflate::TooLarge => "too large".to_owned(),
            Inflate::Broken(message) => message,
        })
    }

    #[test]
    fn a_stream_is_inflated_up_to_the_cap_and_no_further() {
        assert_eq!(inflated(&STORED_ABC, 3).unwrap(), b"abc");
        assert_eq!(inflated(&STORED_ABC, 100).unwrap(), b"abc");
        assert_eq!(inflated(&STORED_ABC, 2).unwrap_err(), "too large");
        // Bytes after the end of the stream are ignored.
        let mut with_tail = STORED_ABC.to_vec();
        with_tail.extend_from_slice(b"trailing");
        assert_eq!(inflated(&with_tail, 3).unwrap(), b"abc");
        // An empty final block.
        assert_eq!(inflated(&[0x03, 0x00], 1).unwrap(), b"");
    }

    #[test]
    fn a_broken_stream_fails_with_zlibs_words() {
        assert_eq!(inflated(&STORED_ABC[..7], 100).unwrap_err(), "unexpected end of file");
        assert_eq!(inflated(&[], 100).unwrap_err(), "unexpected end of file");
        assert_eq!(inflated(&[0x07, 0x01, 0x02, 0x03], 100).unwrap_err(), "invalid block type");
        assert_eq!(inflated(&[0x01, 0x00, 0x00, 0x00, 0x00], 100).unwrap_err(), "invalid stored block lengths");
    }

    /// A container of one entry, written by hand.
    fn container(name: &str, method: u16, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&LOCAL_SIG.to_le_bytes());
        out.extend_from_slice(&[20, 0, 0, 0]);
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        let central_at = out.len() as u32;
        out.extend_from_slice(&CDIR_SIG.to_le_bytes());
        out.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0; 12]);
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        let central_len = out.len() as u32 - central_at;
        out.extend_from_slice(&EOCD_SIG.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&central_len.to_le_bytes());
        out.extend_from_slice(&central_at.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    #[test]
    fn entries_are_read_by_name_stored_or_inflated() {
        let stored = container("a/b.xml", 0, b"hello");
        let zip = Zip::open(&stored, &Limits::default()).unwrap();
        assert!(zip.has("a/b.xml"));
        assert_eq!(zip.names().collect::<Vec<_>>(), vec!["a/b.xml"]);
        assert_eq!(zip.part_text("a/b.xml").unwrap(), "hello");
        assert_eq!(zip.part_text("missing").unwrap(), "");
        assert_eq!(zip.part_text("").unwrap(), "");
        assert!(zip.content("missing").is_none());

        let deflated = container("d.xml", 8, &STORED_ABC);
        let zip = Zip::open(&deflated, &Limits::default()).unwrap();
        assert_eq!(zip.part_text("d.xml").unwrap(), "abc");
    }

    #[test]
    fn the_part_and_container_caps_apply_to_inflated_entries_and_the_part_cap_to_stored_ones() {
        let deflated = container("d.xml", 8, &STORED_ABC);
        let capped = Zip::open(&deflated, &Limits { max_part_bytes: 2, ..Limits::default() }).unwrap();
        let Err(Failure::Other(text)) = capped.part_text("d.xml") else { panic!("expected the cap to apply") };
        assert_eq!(text, "zip entry d.xml is too large when decompressed (limit 2 bytes)");
        let capped = Zip::open(&deflated, &Limits { max_container_bytes: 2, ..Limits::default() }).unwrap();
        let Err(Failure::Other(text)) = capped.part_text("d.xml") else { panic!("expected the cap to apply") };
        assert_eq!(text, "zip entry d.xml is too large when decompressed (limit 2 bytes)");
        // A stored entry is held to the part cap but not counted in the container's budget.
        let stored = container("s.xml", 0, b"hello");
        let capped = Zip::open(&stored, &Limits { max_container_bytes: 1, ..Limits::default() }).unwrap();
        assert_eq!(capped.part_text("s.xml").unwrap(), "hello");
        let capped = Zip::open(&stored, &Limits { max_part_bytes: 4, ..Limits::default() }).unwrap();
        assert!(capped.part_text("s.xml").is_err());
    }

    #[test]
    fn an_unknown_method_is_refused_and_a_buffer_without_an_end_record_is_not_a_container() {
        let odd = container("m.xml", 12, b"x");
        let zip = Zip::open(&odd, &Limits::default()).unwrap();
        let Err(Failure::Other(text)) = zip.part_text("m.xml") else { panic!("expected a refusal") };
        assert_eq!(text, "unsupported ZIP compression method 12");
        assert!(matches!(Zip::open(b"short", &Limits::default()), Err(Failure::Other(_))));
        assert!(matches!(Zip::open(&[0; 100], &Limits::default()), Err(Failure::Other(_))));
    }

    #[test]
    fn invalid_utf8_reads_as_replacement_characters() {
        assert_eq!(utf8_text(vec![b'a', 0xff, b'b']), "a\u{fffd}b");
        assert_eq!(utf8_text("가".as_bytes().to_vec()), "가");
    }
}
