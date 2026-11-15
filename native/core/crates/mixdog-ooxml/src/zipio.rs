//! The container of an Office package: the zip archive as `jszip` held and wrote it. `Package` is the `JSZip` object of
//! the Node code: entries by name in the order `Object.keys(zip.files)` lists them (a name that is a canonical array
//! index first, ascending), `zip.file(name, data)` creating the folder entries above the file, DEFLATE at level 6 for
//! every file entry with content, folders and empty files stored, and the time stamps in MS-DOS form from the UTC fields
//! of the entry's date. A loaded package keeps each entry's own date; a changed or added one is stamped now.
//!
//! The compressed bytes are the `zip` crate's, not pako's, so they differ from Node's; the entry names, their order and
//! the uncompressed bytes are what is equal.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use mixdog_js::JsRegex;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

/// One entry of a package.
#[derive(Debug, Clone)]
pub struct Entry {
    /// The entry name; a folder's ends in a slash.
    pub name: String,
    /// The uncompressed bytes (empty for a folder).
    pub data: Vec<u8>,
    pub dir: bool,
    /// The MS-DOS date and time the entry is written with.
    pub date: DateTime,
}

/// A zip archive held in memory (`JSZip`).
#[derive(Debug, Clone, Default)]
pub struct Package {
    entries: Vec<Entry>,
    index: HashMap<String, usize>,
}

/// The UTC calendar fields of the present moment.
pub(crate) struct UtcNow {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// The civil date of a day count since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

pub(crate) fn utc_now() -> UtcNow {
    let seconds = (mixdog_office_base::clock::now_ms() / 1000.0).floor() as i64;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let of_day = seconds.rem_euclid(86_400) as u32;
    UtcNow { year, month, day, hour: of_day / 3_600, minute: of_day % 3_600 / 60, second: of_day % 60 }
}

/// The DOS date and time of now (UTC fields, two-second resolution, years 1980 to 2107).
fn dos_now() -> DateTime {
    let now = utc_now();
    let year = now.year.clamp(1980, 2107) as u16;
    DateTime::from_date_and_time(year, now.month as u8, now.day as u8, now.hour as u8, now.minute as u8, (now.second / 2 * 2) as u8)
        .unwrap_or_default()
}

/// `utils.resolve`: dot segments and doubled slashes inside a name are folded, `..` removes the segment before it.
fn resolve(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    let mut result: Vec<&str> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if *part == "." || (part.is_empty() && index != 0 && index != parts.len() - 1) {
            continue;
        }
        if *part == ".." {
            result.pop();
        } else {
            result.push(part);
        }
    }
    result.join("/")
}

fn force_trailing_slash(path: &str) -> String {
    if path.ends_with('/') { path.to_owned() } else { format!("{path}/") }
}

/// `parentFolder`: the folder above a path, empty at the top (a slash in the first position is not one).
fn parent_folder(path: &str) -> Option<String> {
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    trimmed.rfind('/').filter(|at| *at > 0).map(|at| trimmed[..at].to_owned())
}

/// Whether an object key is an array index (`"0"`, `"17"`), which a JavaScript object lists before its other keys.
fn array_index(name: &str) -> Option<u32> {
    if name.is_empty() || (name.len() > 1 && name.starts_with('0')) || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    name.parse::<u32>().ok().filter(|value| *value != u32::MAX)
}

/// jszip's reason when no end-of-central-directory record is found: a file that does not begin as a zip is not one, and
/// one that does begin as one is damaged.
fn no_end_of_central_directory(bytes: &[u8]) -> String {
    if bytes.starts_with(b"PK\x03\x04") {
        "Corrupted zip: can't find end of central directory".to_owned()
    } else {
        "Can't find end of central directory : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html".to_owned()
    }
}

/// The text a failed read is reported with: jszip's wording where the cause is the same.
fn read_error(error: &ZipError, bytes: &[u8]) -> String {
    match error {
        ZipError::InvalidArchive(message) if message.contains("Could not find EOCD") => no_end_of_central_directory(bytes),
        ZipError::UnsupportedArchive(message) if *message == ZipError::PASSWORD_REQUIRED => {
            "Encrypted zip are not supported".to_owned()
        }
        other => other.to_string(),
    }
}

impl Package {
    pub fn new() -> Self {
        Self::default()
    }

    fn position(&self, name: &str) -> Option<usize> {
        self.index.get(name).copied()
    }

    fn reindex(&mut self) {
        self.index = self.entries.iter().enumerate().map(|(at, entry)| (entry.name.clone(), at)).collect();
    }

    /// `this.files[name] = object`: an existing name keeps its place, a new one goes last.
    fn put(&mut self, entry: Entry) {
        match self.position(&entry.name) {
            Some(at) => self.entries[at] = entry,
            None => {
                self.index.insert(entry.name.clone(), self.entries.len());
                self.entries.push(entry);
            }
        }
    }

    /// `fileAdd`: a folder (or a file with no content) carries no data; with `create_folders` the folders above the name
    /// are added first.
    fn add(&mut self, name: &str, data: Vec<u8>, dir: bool, date: DateTime, create_folders: bool) {
        let name = if dir { force_trailing_slash(name) } else { name.to_owned() };
        if create_folders {
            if let Some(parent) = parent_folder(&name) {
                self.folder_add(&parent);
            }
        }
        self.put(Entry { name, data: if dir { Vec::new() } else { data }, dir, date });
    }

    /// `folderAdd(name, true)`.
    fn folder_add(&mut self, name: &str) {
        let name = force_trailing_slash(name);
        if self.position(&name).is_none() {
            self.add(&name, Vec::new(), true, dos_now(), true);
        }
    }

    /// `JSZip.loadAsync(data, { checkCRC32: true, createFolders: false })`.
    pub fn load(bytes: &[u8]) -> Result<Self, String> {
        Self::load_with(bytes, true)
    }

    /// `JSZip.loadAsync(data)`: the checksum of an entry is not compared (the fingerprint reads packages this way).
    pub fn load_unchecked(bytes: &[u8]) -> Result<Self, String> {
        Self::load_with(bytes, false)
    }

    /// `JSZip.loadAsync(readFile(path))` as a caller that does not go through the package reader's error clean-up sees
    /// it: jszip's own wording for a file with no end-of-central-directory record keeps the hint it appends.
    pub fn load_unchecked_raw_error(bytes: &[u8]) -> Result<Self, String> {
        Self::load_unchecked(bytes).map_err(|message| {
            if message == "Can't find end of central directory" {
                format!("{message} : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html")
            } else {
                message
            }
        })
    }

    fn load_with(bytes: &[u8], check_crc: bool) -> Result<Self, String> {
        if bytes.len() < 22 {
            return Err(no_end_of_central_directory(bytes));
        }
        let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| read_error(&error, bytes))?;
        let mut package = Self::new();
        for number in 0..archive.len() {
            let mut file = archive.by_index(number).map_err(|error| read_error(&error, bytes))?;
            let name = resolve(file.name());
            let dir = file.is_dir() || file.unix_mode().is_some_and(|mode| mode & 0x4000 != 0);
            let date = file.last_modified().unwrap_or_default();
            let mut data = Vec::new();
            if !dir {
                // A checksum that does not match is reported after the whole entry was read: kept when it is not compared.
                if let Err(error) = file.read_to_end(&mut data) {
                    let checksum = error.kind() == std::io::ErrorKind::InvalidData && error.to_string().contains("Invalid checksum");
                    if !checksum {
                        return Err(error.to_string());
                    }
                    if check_crc {
                        return Err("Corrupted zip : CRC32 mismatch".to_owned());
                    }
                }
            }
            package.add(&name, data, dir, date, false);
        }
        Ok(package)
    }

    /// The entries in the order `Object.keys(zip.files)` lists them.
    pub fn entries(&self) -> Vec<&Entry> {
        let mut indexed: Vec<(u32, &Entry)> = Vec::new();
        let mut others: Vec<&Entry> = Vec::new();
        for entry in &self.entries {
            match array_index(&entry.name) {
                Some(value) => indexed.push((value, entry)),
                None => others.push(entry),
            }
        }
        indexed.sort_by_key(|(value, _)| *value);
        indexed.into_iter().map(|(_, entry)| entry).chain(others).collect()
    }

    /// `Object.keys(zip.files)`.
    pub fn names(&self) -> Vec<String> {
        self.entries().into_iter().map(|entry| entry.name.clone()).collect()
    }

    /// Whether `zip.files` holds the name (a folder counts).
    pub fn contains(&self, name: &str) -> bool {
        self.position(name).is_some()
    }

    /// The entry of a name, a folder included (`zip.files[name]`).
    pub fn entry(&self, name: &str) -> Option<&Entry> {
        self.position(name).map(|at| &self.entries[at])
    }

    /// `zip.file(name)`: the bytes of a file; a folder or a missing name is `None`.
    pub fn file(&self, name: &str) -> Option<&[u8]> {
        self.entry(name).filter(|entry| !entry.dir).map(|entry| entry.data.as_slice())
    }

    /// `zipText(zip, name)`: the file as UTF-8 text (an invalid sequence reads as U+FFFD), empty when it is missing.
    pub fn text(&self, name: &str) -> String {
        self.file(name).map(|bytes| String::from_utf8_lossy(bytes).into_owned()).unwrap_or_default()
    }

    /// `zip.file(name, data)`: the folders above the name are added when they are missing.
    pub fn set(&mut self, name: &str, data: impl Into<Vec<u8>>) {
        self.add(name, data.into(), false, dos_now(), true);
    }

    /// `zip.folder(name)`: a folder entry, and the ones above it.
    pub fn folder(&mut self, name: &str) {
        self.folder_add(name);
    }

    /// `zip.file(regexp)`: the files whose name the pattern matches, in entry order.
    pub fn files_matching(&self, pattern: &JsRegex) -> Vec<String> {
        self.entries().into_iter().filter(|entry| !entry.dir && pattern.is_match(&entry.name)).map(|entry| entry.name.clone()).collect()
    }

    /// `zip.remove(name)`: a file is removed alone; a folder (with or without its slash) with everything under it.
    pub fn remove(&mut self, name: &str) {
        let mut name = name.to_owned();
        let mut found = self.position(&name);
        if found.is_none() {
            if !name.ends_with('/') {
                name.push('/');
            }
            found = self.position(&name);
        }
        match found {
            Some(at) if !self.entries[at].dir => {
                self.entries.remove(at);
            }
            _ => self.entries.retain(|entry| !entry.name.starts_with(&name)),
        }
        self.reindex();
    }

    /// `zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' })`.
    pub fn generate(&self) -> Result<Vec<u8>, String> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for entry in self.entries() {
            let base = SimpleFileOptions::default().last_modified_time(entry.date);
            if entry.dir {
                writer.add_directory(entry.name.as_str(), base).map_err(|error| error.to_string())?;
                continue;
            }
            let options = if entry.data.is_empty() {
                base.compression_method(CompressionMethod::Stored)
            } else {
                base.compression_method(CompressionMethod::Deflated).compression_level(Some(6))
            };
            writer.start_file(entry.name.as_str(), options).map_err(|error| error.to_string())?;
            writer.write_all(&entry.data).map_err(|error| error.to_string())?;
        }
        let mut bytes = writer.finish().map(Cursor::into_inner).map_err(|error| error.to_string())?;
        as_written_for_dos(&mut bytes);
        Ok(bytes)
    }
}

/// What `platform: 'DOS'` writes where the `zip` crate writes a Unix archive: the entries are made by the DOS platform,
/// the version needed to extract is 10 in the local header and the central entry, and the external attributes of a file
/// are 0 (a folder has the DOS directory flag, 0x10), not the Unix mode in the high half.
fn as_written_for_dos(bytes: &mut [u8]) {
    let read16 = |bytes: &[u8], at: usize| usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    let read32 = |bytes: &[u8], at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
    let Some(end) = (0..bytes.len().saturating_sub(21)).rev().find(|at| bytes[*at..*at + 4] == *b"PK\x05\x06") else { return };
    let count = read16(bytes, end + 10);
    let mut at = read32(bytes, end + 16);
    for _ in 0..count {
        if at + 46 > bytes.len() || bytes[at..at + 4] != *b"PK\x01\x02" {
            return;
        }
        let (name_length, extra_length, comment_length) = (read16(bytes, at + 28), read16(bytes, at + 30), read16(bytes, at + 32));
        let folder = bytes[at + 46 + name_length - 1] == b'/';
        bytes[at + 4..at + 6].copy_from_slice(&20_u16.to_le_bytes());
        bytes[at + 6..at + 8].copy_from_slice(&10_u16.to_le_bytes());
        bytes[at + 38..at + 42].copy_from_slice(&(if folder { 0x10_u32 } else { 0 }).to_le_bytes());
        let local = read32(bytes, at + 42);
        if local + 6 <= bytes.len() && bytes[local..local + 4] == *b"PK\x03\x04" {
            bytes[local + 4..local + 6].copy_from_slice(&10_u16.to_le_bytes());
        }
        at += 46 + name_length + extra_length + comment_length;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_added_under_a_path_adds_its_folders_first() {
        let mut package = Package::new();
        package.set("[Content_Types].xml", "<Types/>");
        package.set("word/media/image1.png", vec![1_u8, 2, 3]);
        package.set("word/document.xml", "<w:document/>");
        assert_eq!(
            package.names(),
            ["[Content_Types].xml", "word/", "word/media/", "word/media/image1.png", "word/document.xml"]
        );
        assert!(package.entry("word/").is_some_and(|entry| entry.dir));
        assert_eq!(package.file("word/"), None);
        assert_eq!(package.file("word/media/image1.png"), Some(&[1_u8, 2, 3][..]));
    }

    #[test]
    fn replacing_a_file_keeps_its_place_and_removing_then_adding_moves_it_last() {
        let mut package = Package::new();
        package.set("a.xml", "1");
        package.set("b.xml", "2");
        package.set("a.xml", "3");
        assert_eq!(package.names(), ["a.xml", "b.xml"]);
        assert_eq!(package.text("a.xml"), "3");
        package.remove("a.xml");
        package.set("a.xml", "4");
        assert_eq!(package.names(), ["b.xml", "a.xml"]);
        assert_eq!(package.text("missing.xml"), "");
    }

    #[test]
    fn removing_a_folder_removes_what_is_under_it_with_or_without_the_slash() {
        let mut package = Package::new();
        package.set("x/a.xml", "1");
        package.set("x/y/b.xml", "2");
        package.set("xy.xml", "3");
        let mut other = package.clone();
        package.remove("x");
        assert_eq!(package.names(), ["xy.xml"]);
        other.remove("x/");
        assert_eq!(other.names(), ["xy.xml"]);
    }

    #[test]
    fn names_that_are_array_indexes_list_first() {
        let mut package = Package::new();
        package.set("b.xml", "1");
        package.set("10", "2");
        package.set("9", "3");
        package.set("09", "4");
        assert_eq!(package.names(), ["9", "10", "b.xml", "09"]);
    }

    #[test]
    fn a_generated_package_loads_back_with_the_same_entries() {
        let mut package = Package::new();
        package.set("[Content_Types].xml", "<Types/>");
        package.set("a/한글.xml", "내용");
        package.set("empty.bin", Vec::<u8>::new());
        let bytes = package.generate().expect("generate");
        let loaded = Package::load(&bytes).expect("load");
        assert_eq!(loaded.names(), package.names());
        assert_eq!(loaded.text("a/한글.xml"), "내용");
        assert_eq!(loaded.file("empty.bin"), Some(&[0_u8; 0][..]));
        assert!(loaded.entry("a/").is_some_and(|entry| entry.dir));
    }

    #[test]
    fn dot_segments_in_a_loaded_name_are_folded() {
        assert_eq!(resolve("a/./b//c/../d.xml"), "a/b/d.xml");
        assert_eq!(resolve("folder/"), "folder/");
        assert_eq!(resolve("/rooted"), "/rooted");
    }

    fn stored(name: &str, content: &[u8]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file(name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).expect("start");
        writer.write_all(content).expect("write");
        writer.finish().expect("finish").into_inner()
    }

    #[test]
    fn a_checksum_that_does_not_match_is_refused_unless_the_load_is_unchecked() {
        let mut bytes = stored("a.txt", b"hello world");
        let at = bytes.windows(5).position(|window| window == b"hello").expect("content");
        bytes[at] = b'j';
        assert_eq!(Package::load(&bytes).unwrap_err(), "Corrupted zip : CRC32 mismatch");
        assert_eq!(Package::load_unchecked(&bytes).expect("unchecked").text("a.txt"), "jello world");
    }

    #[test]
    fn a_file_that_is_not_a_zip_says_so_in_jszips_words() {
        const WORDS: &str = "Can't find end of central directory : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html";
        assert_eq!(Package::load(b"not a zip at all, just text").unwrap_err(), WORDS);
        assert_eq!(Package::load(b"").unwrap_err(), WORDS);
        let bytes = stored("a.txt", b"hello");
        assert_eq!(Package::load(&bytes[..bytes.len() - 22]).unwrap_err(), "Corrupted zip: can't find end of central directory");
    }

    #[test]
    fn the_civil_date_of_a_day_count() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }
}
