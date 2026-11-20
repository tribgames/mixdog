//! A bounded reader of the Compound File Binary container ([MS-CFB]) that an encrypted Office document is.
//!
//! The cached `cfb` crate is not used: these refusals are the tested contract. The container is untrusted, so every
//! count and size it declares is checked against its real length before it is used, every sector chain is walked with
//! a record of the sectors it visited (a sector seen twice is a cycle, and the container malformed), and no walk goes
//! past a fixed number of sectors, whatever the file declares. Only the header, the directory sectors and the streams
//! asked for are read, never the whole file. The messages of the refusals are fixed texts.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{Read, Seek, SeekFrom};

const SIGNATURE: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEADER_SIZE: usize = 512;
const HEADER_DIFAT_ENTRIES: u64 = 109;
const DIRECTORY_ENTRY_SIZE: u64 = 128;
const MINI_SECTOR_SIZE: u64 = 64;
/// [MS-CFB] 2.2: the mini stream cutoff MUST be 4096 bytes.
const MINI_STREAM_CUTOFF: u64 = 4096;
const MAX_REGULAR_SECTOR: u32 = 0xffff_fffa;
const END_OF_CHAIN: u32 = 0xffff_fffe;
const NO_STREAM: u32 = 0xffff_ffff;
const ENTRY_STREAM: u8 = 2;
const ENTRY_ROOT_STORAGE: u8 = 5;
const MAX_DIRECTORY_BYTES: u64 = 1024 * 1024;
/// Beyond this an encrypted package is not unlocked for a preview (it is decrypted in memory).
pub const MAX_ENCRYPTION_INFO_BYTES: u64 = 64 * 1024;
pub const MAX_ENCRYPTED_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
/// The most sectors any one chain walk visits: the 512-byte sectors of the largest stream ever read.
const MAX_CHAIN_SECTORS: u64 = MAX_ENCRYPTED_PACKAGE_BYTES / 512;

/// A container that cannot be read, with its fixed refusal message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CfbError(String);

impl CfbError {
    fn new(message: &str) -> Self {
        Self(message.to_owned())
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CfbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CfbError {}

type Result<T> = std::result::Result<T, CfbError>;

fn refuse<T>(message: &str) -> Result<T> {
    Err(CfbError::new(message))
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(raw)
}

/// Stream names are compared case-insensitively by uppercase mapping ([MS-CFB] 2.6.4), so they are keyed uppercase.
fn stream_key(name: &str) -> String {
    name.to_uppercase()
}

#[derive(Clone, Debug)]
struct Entry {
    name: String,
    kind: u8,
    left: u32,
    right: u32,
    child: u32,
    start: u32,
    size: u64,
}

/// A sector chain from `first`, followed lazily and remembered: `get(n)` is its n-th sector, or `None` past its end. A
/// chain longer than `limit` sectors (or `MAX_CHAIN_SECTORS`), one that leaves the file, or one that comes back to a
/// sector it already visited is malformed.
struct Chain {
    first: u32,
    limit: u64,
    sectors: Vec<u32>,
    seen: HashSet<u32>,
    ended: bool,
}

impl Chain {
    fn new(first: u32, limit: u64) -> Self {
        Self { first, limit, sectors: Vec::new(), seen: HashSet::new(), ended: false }
    }

    fn get<R: Read + Seek>(&mut self, file: &mut CompoundFile<R>, index: usize) -> Result<Option<u32>> {
        while self.sectors.len() <= index {
            if self.ended {
                return Ok(None);
            }
            let sector = match self.sectors.last() {
                Some(&last) => file.next_sector(last)?,
                None => self.first,
            };
            if sector == END_OF_CHAIN {
                self.ended = true;
                return Ok(None);
            }
            if sector > MAX_REGULAR_SECTOR || u64::from(sector) >= file.sectors_in_file {
                return refuse("sector outside the file");
            }
            if self.seen.contains(&sector) {
                return refuse("cyclic sector chain");
            }
            if self.sectors.len() as u64 >= self.limit.min(MAX_CHAIN_SECTORS) {
                return refuse("sector chain too long");
            }
            self.seen.insert(sector);
            self.sectors.push(sector);
        }
        Ok(Some(self.sectors[index]))
    }
}

/// An open compound file: the header, the directory and the root-level streams it lists.
pub struct CompoundFile<R> {
    reader: R,
    file_size: u64,
    major_version: u16,
    sector_size: u64,
    entries_per_sector: u64,
    sectors_in_file: u64,
    fat_sector_count: u64,
    mini_fat_sector_count: u64,
    difat_sector_count: u64,
    first_difat_sector: u32,
    first_mini_fat_sector: u32,
    header: Vec<u8>,
    difat_sectors: Vec<u32>,
    difat_seen: HashSet<u32>,
    fat_sectors: HashMap<u64, Vec<u8>>,
    root: Entry,
    streams: HashMap<String, Entry>,
    mini_stream_chain: Option<Chain>,
    mini_fat_chain: Option<Chain>,
}

impl<R: Read + Seek> CompoundFile<R> {
    /// Reads the header and the directory sector chain, and lists the streams directly under the root storage.
    pub fn open(mut reader: R) -> Result<Self> {
        let file_size = reader.seek(SeekFrom::End(0)).map_err(|_| CfbError::new("truncated compound file"))?;
        let header = read_exactly(&mut reader, file_size, 0, HEADER_SIZE as u64)?;
        let major_version = u16_at(&header, 26);
        let sector_shift = u16_at(&header, 30);
        let expected_shift = match major_version {
            3 => Some(9),
            4 => Some(12),
            _ => None,
        };
        if header[..SIGNATURE.len()] != SIGNATURE
            || u16_at(&header, 28) != 0xfffe
            || Some(sector_shift) != expected_shift
            || u16_at(&header, 32) != 6
            || u64::from(u32_at(&header, 56)) != MINI_STREAM_CUTOFF
        {
            return refuse("not a compound file");
        }
        let sector_size = 1u64 << sector_shift;
        let entries_per_sector = sector_size / 4;
        // Sector n starts at byte (n + 1) * sectorSize, after the header sector; a last partial sector still counts.
        let sectors_in_file = file_size.div_ceil(sector_size).saturating_sub(1);
        let fat_sector_count = u64::from(u32_at(&header, 44));
        let mini_fat_sector_count = u64::from(u32_at(&header, 64));
        let difat_sector_count = u64::from(u32_at(&header, 72));
        // A count of sectors larger than the file has sectors is false.
        if fat_sector_count.max(mini_fat_sector_count).max(difat_sector_count) > sectors_in_file {
            return refuse("sector counts beyond the file");
        }
        let placeholder = Entry { name: String::new(), kind: 0, left: 0, right: 0, child: 0, start: 0, size: 0 };
        let mut file = Self {
            reader,
            file_size,
            major_version,
            sector_size,
            entries_per_sector,
            sectors_in_file,
            fat_sector_count,
            mini_fat_sector_count,
            difat_sector_count,
            first_difat_sector: u32_at(&header, 68),
            first_mini_fat_sector: u32_at(&header, 60),
            difat_sectors: Vec::new(),
            difat_seen: HashSet::new(),
            fat_sectors: HashMap::new(),
            root: placeholder,
            streams: HashMap::new(),
            mini_stream_chain: None,
            mini_fat_chain: None,
            header,
        };
        file.read_directory()?;
        Ok(file)
    }

    fn read_directory(&mut self) -> Result<()> {
        let mut parts: Vec<u8> = Vec::new();
        let mut chain = Chain::new(u32_at(&self.header, 48), MAX_DIRECTORY_BYTES / self.sector_size);
        let mut count = 0usize;
        while let Some(sector) = chain.get(self, count)? {
            parts.extend_from_slice(&self.read_sector(sector, 0, self.sector_size)?);
            count += 1;
        }
        let directory = parts;
        let root = self.entry_at(&directory, 0)?;
        if root.kind != ENTRY_ROOT_STORAGE {
            return refuse("missing root storage");
        }
        // Only the siblings directly under the root: a storage's own children are never followed.
        let mut streams = HashMap::new();
        let mut visited = HashSet::new();
        let mut pending = vec![root.child];
        while let Some(id) = pending.pop() {
            if id == NO_STREAM {
                continue;
            }
            if !visited.insert(id) {
                return refuse("cyclic directory tree");
            }
            let entry = self.entry_at(&directory, id)?;
            pending.push(entry.left);
            pending.push(entry.right);
            if entry.kind == ENTRY_STREAM {
                streams.insert(entry.name.clone(), entry);
            }
        }
        self.root = root;
        self.streams = streams;
        Ok(())
    }

    fn entry_at(&self, directory: &[u8], id: u32) -> Result<Entry> {
        let at = u64::from(id) * DIRECTORY_ENTRY_SIZE;
        if at + DIRECTORY_ENTRY_SIZE > directory.len() as u64 {
            return refuse("directory entry out of range");
        }
        let at = at as usize;
        let name_bytes = usize::from(u16_at(directory, at + 64));
        if name_bytes > 64 {
            return refuse("directory entry name too long");
        }
        let units: Vec<u16> = directory[at..at + name_bytes.saturating_sub(2)].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        Ok(Entry {
            name: stream_key(&String::from_utf16_lossy(&units)),
            kind: directory[at + 66],
            left: u32_at(directory, at + 68),
            right: u32_at(directory, at + 72),
            child: u32_at(directory, at + 76),
            start: u32_at(directory, at + 116),
            // Version 3 files may leave the high half of the size uninitialized; it is ignored there.
            size: if self.major_version == 3 { u64::from(u32_at(directory, at + 120)) } else { u64_at(directory, at + 120) },
        })
    }

    fn read_sector(&mut self, sector: u32, offset: u64, length: u64) -> Result<Vec<u8>> {
        if sector > MAX_REGULAR_SECTOR || u64::from(sector) >= self.sectors_in_file {
            return refuse("sector number out of range");
        }
        read_exactly(&mut self.reader, self.file_size, (u64::from(sector) + 1) * self.sector_size + offset, length)
    }

    fn read_u32(&mut self, sector: u32, offset: u64) -> Result<u32> {
        Ok(u32_at(&self.read_sector(sector, offset, 4)?, 0))
    }

    /// The DIFAT sector chain (2.5), followed lazily through the last entry of each of its sectors.
    fn difat_sector(&mut self, hop: u64) -> Result<u32> {
        if hop >= self.difat_sector_count.min(MAX_CHAIN_SECTORS) {
            return refuse("sector beyond the DIFAT");
        }
        while self.difat_sectors.len() as u64 <= hop {
            let sector = match self.difat_sectors.last() {
                Some(&last) => self.read_u32(last, (self.entries_per_sector - 1) * 4)?,
                None => self.first_difat_sector,
            };
            if !self.difat_seen.insert(sector) {
                return refuse("cyclic DIFAT chain");
            }
            self.difat_sectors.push(sector);
        }
        Ok(self.difat_sectors[hop as usize])
    }

    /// Location of the index-th FAT sector: the first 109 are in the header, the rest in the DIFAT sector chain (2.5).
    fn fat_sector_location(&mut self, index: u64) -> Result<u32> {
        if index >= self.fat_sector_count {
            return refuse("sector beyond the FAT");
        }
        if index < HEADER_DIFAT_ENTRIES {
            return Ok(u32_at(&self.header, 76 + index as usize * 4));
        }
        let per_difat_sector = self.entries_per_sector - 1;
        let past = index - HEADER_DIFAT_ENTRIES;
        let sector = self.difat_sector(past / per_difat_sector)?;
        self.read_u32(sector, (past % per_difat_sector) * 4)
    }

    /// A whole stream walks one FAT entry per sector, so each FAT sector is read once and kept.
    fn next_sector(&mut self, sector: u32) -> Result<u32> {
        let index = u64::from(sector) / self.entries_per_sector;
        if !self.fat_sectors.contains_key(&index) {
            let location = self.fat_sector_location(index)?;
            let fat = self.read_sector(location, 0, self.sector_size)?;
            self.fat_sectors.insert(index, fat);
        }
        let fat = &self.fat_sectors[&index];
        Ok(u32_at(fat, (u64::from(sector) % self.entries_per_sector) as usize * 4))
    }

    /// The mini stream ([MS-CFB] 2.6.2) is the root entry's own stream: root.size bytes, which cannot be more than the
    /// file holds, in a regular sector chain followed lazily and shared by every read. Nothing past the root entry's
    /// size is stream data. A read never crosses a sector: mini sectors are 64-byte aligned and a read is at most one
    /// of them.
    fn read_mini_stream(&mut self, offset: u64, length: u64) -> Result<Vec<u8>> {
        if offset + length > self.root.size {
            return refuse("mini stream too short");
        }
        if self.root.size > self.sectors_in_file * self.sector_size {
            return refuse("mini stream larger than the file");
        }
        let mut chain = match self.mini_stream_chain.take() {
            Some(chain) => chain,
            None => Chain::new(self.root.start, self.root.size.div_ceil(self.sector_size)),
        };
        let sector = chain.get(self, (offset / self.sector_size) as usize);
        self.mini_stream_chain = Some(chain);
        match sector? {
            Some(sector) => self.read_sector(sector, offset % self.sector_size, length),
            None => refuse("mini stream sector missing"),
        }
    }

    /// The mini FAT (header offset 60, at most miniFatSectorCount sectors) maps each mini sector to the next one.
    fn next_mini_sector(&mut self, mini: u32) -> Result<u32> {
        let mut chain = match self.mini_fat_chain.take() {
            Some(chain) => chain,
            None => Chain::new(self.first_mini_fat_sector, self.mini_fat_sector_count),
        };
        let sector = chain.get(self, (u64::from(mini) / self.entries_per_sector) as usize);
        self.mini_fat_chain = Some(chain);
        match sector? {
            Some(sector) => self.read_u32(sector, (u64::from(mini) % self.entries_per_sector) * 4),
            None => refuse("mini FAT too short"),
        }
    }

    #[must_use]
    pub fn has_stream(&self, name: &str) -> bool {
        self.streams.contains_key(&stream_key(name))
    }

    /// The first `length` (at most 64) bytes of a root-level stream. A stream under the mini-stream cutoff lives in the
    /// root entry's mini stream ([MS-CFB] 2.6.2), whose mini sector `start` sits at a 64-byte multiple.
    pub fn read_stream_head(&mut self, name: &str, length: u64) -> Result<Vec<u8>> {
        let entry = match self.streams.get(&stream_key(name)) {
            Some(entry) if entry.size >= length => entry.clone(),
            _ => return refuse("stream missing or too short"),
        };
        if entry.size >= MINI_STREAM_CUTOFF {
            return self.read_sector(entry.start, 0, length);
        }
        self.read_mini_stream(u64::from(entry.start) * MINI_SECTOR_SIZE, length)
    }

    /// A whole root-level stream of at most `max_bytes`. Regular sectors are read in contiguous runs; a stream under
    /// the cutoff follows its mini FAT chain through the root entry's mini stream ([MS-CFB] 2.3), each mini sector
    /// once.
    pub fn read_stream(&mut self, name: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let entry = match self.streams.get(&stream_key(name)) {
            Some(entry) if entry.size <= max_bytes => entry.clone(),
            _ => return refuse("stream missing or too large"),
        };
        if entry.size >= MINI_STREAM_CUTOFF {
            let sector_count = entry.size.div_ceil(self.sector_size);
            let mut chain = Chain::new(entry.start, sector_count);
            let mut runs: Vec<(u32, u64)> = Vec::new();
            for index in 0..sector_count {
                let Some(sector) = chain.get(self, index as usize)? else {
                    return refuse("stream shorter than its size");
                };
                match runs.last_mut() {
                    Some((first, count)) if u64::from(sector) == u64::from(*first) + *count => *count += 1,
                    _ => runs.push((sector, 1)),
                }
            }
            let mut data = Vec::new();
            for (first, count) in runs {
                data.extend_from_slice(&self.read_sector(first, 0, count * self.sector_size)?);
            }
            data.truncate(entry.size as usize);
            return Ok(data);
        }
        let mini_count = entry.size.div_ceil(MINI_SECTOR_SIZE);
        let mut data = Vec::new();
        let mut seen = HashSet::new();
        let mut mini = entry.start;
        for index in 0..mini_count {
            if index > 0 {
                mini = self.next_mini_sector(mini)?;
            }
            if !seen.insert(mini) {
                return refuse("cyclic mini sector chain");
            }
            data.extend_from_slice(&self.read_mini_stream(u64::from(mini) * MINI_SECTOR_SIZE, MINI_SECTOR_SIZE)?);
        }
        data.truncate(entry.size as usize);
        Ok(data)
    }
}

/// `length` bytes at `position`: a read that goes past the end of the file is a truncated container (checked before
/// the buffer is allocated, so a declared length never costs memory the file cannot back).
fn read_exactly<R: Read + Seek>(reader: &mut R, file_size: u64, position: u64, length: u64) -> Result<Vec<u8>> {
    let truncated = || CfbError::new("truncated compound file");
    match position.checked_add(length) {
        Some(end) if end <= file_size => {}
        _ => return Err(truncated()),
    }
    reader.seek(SeekFrom::Start(position)).map_err(|_| truncated())?;
    let mut buffer = vec![0u8; length as usize];
    reader.read_exact(&mut buffer).map_err(|_| truncated())?;
    Ok(buffer)
}
