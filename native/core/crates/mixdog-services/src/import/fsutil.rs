//! Path rules and bounded line reading shared by discovery and conversion.

use std::fmt;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use mixdog_js::device_paths::{is_unc_path, is_windows_device_path};

use super::codex::COMPRESSED_ROLLOUT_SUFFIX;

/// A language-neutral failure: the message is the code itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportError(pub String);

impl ImportError {
    pub fn new(code: &str) -> Self {
        Self(code.to_owned())
    }
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ImportError {}

/// `compareCodeUnits`: order by UTF-16 code units, which differs from byte order for characters
/// above the Basic Multilingual Plane.
pub fn compare_code_units(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub fn case_fold(value: &str) -> String {
    if cfg!(windows) { value.to_lowercase() } else { value.to_owned() }
}

/// The path as users know it: Windows' verbatim `\\?\C:\…` and `\\?\UNC\…` forms of a
/// canonical path lose their prefix.
pub fn simplify(path: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return path;
    }
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

pub fn real_path(path: &Path) -> io::Result<PathBuf> {
    std::fs::canonicalize(path).map(simplify)
}

pub fn is_inside(root: &Path, path: &Path) -> bool {
    let (root, path) = (case_fold(&root.to_string_lossy()), case_fold(&path.to_string_lossy()));
    Path::new(&path).strip_prefix(Path::new(&root)).is_ok()
}

pub fn is_compressed(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(COMPRESSED_ROLLOUT_SUFFIX))
}

/// A candidate's file: plain, or the decompressed bytes of a compressed rollout.
pub enum Opened {
    Plain(File),
    Zstd(Box<zstd::Decoder<'static, io::BufReader<File>>>),
}

impl Read for Opened {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(f) => f.read(buf),
            Self::Zstd(d) => d.read(buf),
        }
    }
}

/// Opens `path` and proves the opened file is still the one enumerated: its current real path is
/// `path` (inside `root` for an enumerated candidate, never a network or device path) and names
/// the same file as the open handle. A link or junction swapped in after enumeration fails
/// `unreadable`.
pub fn open_verified(path: &Path, root: Option<&Path>) -> Result<Opened, ImportError> {
    let unreadable = |_| ImportError::new("unreadable");
    let file = File::open(path).map_err(unreadable)?;
    let real = real_path(path).map_err(unreadable)?;
    let opened = same_file::Handle::from_file(file.try_clone().map_err(unreadable)?).map_err(unreadable)?;
    let current = same_file::Handle::from_path(&real).map_err(unreadable)?;
    let is_file = file.metadata().map(|m| m.is_file()).unwrap_or(false);
    if !is_file
        || is_unc_path(&real.to_string_lossy())
        || is_windows_device_path(&real.to_string_lossy())
        || case_fold(&real.to_string_lossy()) != case_fold(&path.to_string_lossy())
        || root.is_some_and(|r| !is_inside(r, &real))
        || opened != current
    {
        return Err(ImportError::new("unreadable"));
    }
    if is_compressed(path) {
        let decoder = zstd::Decoder::new(file).map_err(unreadable)?;
        Ok(Opened::Zstd(Box::new(decoder)))
    } else {
        Ok(Opened::Plain(file))
    }
}

pub struct StreamOpts<'a> {
    pub max_line_bytes: usize,
    pub chunk_bytes: usize,
    pub max_bytes: u64,
    /// Called with the bytes read so far after each chunk; `false` stops.
    pub on_chunk: Option<&'a mut dyn FnMut(u64) -> bool>,
}

#[derive(Debug, Default)]
pub struct StreamOutcome {
    pub bytes_read: u64,
    pub eof: bool,
    pub overflow: bool,
    pub truncated: bool,
    /// The cut-off first line when the byte budget ended inside it.
    pub first_partial: Option<String>,
}

fn read_some<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        match reader.read(buf) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

/// Streams a file's lines (split on LF; the converter strips BOM and CR) into `on_line`, holding
/// at most one line plus one chunk in memory. Stops when `on_line` or `on_chunk` returns false,
/// when a line exceeds `max_line_bytes` (`overflow`), or after `max_bytes` with more to read
/// (`truncated`).
pub fn stream_jsonl_lines<R: Read>(
    reader: &mut R,
    on_line: &mut dyn FnMut(&str) -> bool,
    mut opts: StreamOpts<'_>,
) -> io::Result<StreamOutcome> {
    let mut chunk = vec![0u8; opts.chunk_bytes];
    let mut pending: Vec<u8> = Vec::new();
    let mut position = 0u64;
    let mut lines = 0u64;
    let outcome = |position: u64, f: &dyn Fn(&mut StreamOutcome)| {
        let mut o = StreamOutcome { bytes_read: position, ..Default::default() };
        f(&mut o);
        o
    };
    loop {
        let room = opts.max_bytes.saturating_sub(position).min(opts.chunk_bytes as u64) as usize;
        // At the byte budget: probe one byte to tell a cut-off from the end of file.
        let n = read_some(reader, &mut chunk[..room.max(1)])?;
        if n == 0 {
            break;
        }
        if room == 0 {
            let first_partial = (lines == 0 && !pending.is_empty()).then(|| String::from_utf8_lossy(&pending).into_owned());
            return Ok(outcome(position, &|o| {
                o.truncated = true;
                o.first_partial = first_partial.clone();
            }));
        }
        position += n as u64;
        let view = &chunk[..n];
        let mut start = 0usize;
        while let Some(rel) = view[start..].iter().position(|b| *b == b'\n') {
            let newline = start + rel;
            if pending.len() + (newline - start) > opts.max_line_bytes {
                return Ok(outcome(position, &|o| o.overflow = true));
            }
            let keep_going = if pending.is_empty() {
                on_line(&String::from_utf8_lossy(&view[start..newline]))
            } else {
                pending.extend_from_slice(&view[start..newline]);
                let line = String::from_utf8_lossy(&pending).into_owned();
                pending.clear();
                on_line(&line)
            };
            lines += 1;
            if !keep_going {
                return Ok(outcome(position, &|_| {}));
            }
            start = newline + 1;
        }
        if start < n {
            if pending.len() + (n - start) > opts.max_line_bytes {
                return Ok(outcome(position, &|o| o.overflow = true));
            }
            pending.extend_from_slice(&view[start..]);
        }
        if let Some(on_chunk) = opts.on_chunk.as_mut() {
            if !on_chunk(position) {
                return Ok(outcome(position, &|_| {}));
            }
        }
    }
    if !pending.is_empty() && !on_line(&String::from_utf8_lossy(&pending)) {
        return Ok(outcome(position, &|_| {}));
    }
    Ok(outcome(position, &|o| o.eof = true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(data: &[u8], max_line: usize, chunk: usize, max_bytes: u64) -> (Vec<String>, StreamOutcome) {
        let mut lines = Vec::new();
        let outcome = stream_jsonl_lines(
            &mut &data[..],
            &mut |l| {
                lines.push(l.to_owned());
                true
            },
            StreamOpts { max_line_bytes: max_line, chunk_bytes: chunk, max_bytes, on_chunk: None },
        )
        .unwrap();
        (lines, outcome)
    }

    #[test]
    fn lines_span_chunks_and_the_last_line_needs_no_newline() {
        let (lines, o) = run(b"alpha\nbeta\ngamma", 100, 4, u64::MAX);
        assert_eq!(lines, ["alpha", "beta", "gamma"]);
        assert!(o.eof && !o.overflow && !o.truncated && o.bytes_read == 16);
    }

    #[test]
    fn a_long_line_overflows_and_a_budget_truncates_with_the_first_partial() {
        assert!(run(b"abcdefghij\n", 5, 4, u64::MAX).1.overflow);
        let (lines, o) = run(b"abcdefghij\nnext\n", 100, 4, 6);
        assert!(lines.is_empty() && o.truncated);
        assert_eq!(o.first_partial.as_deref(), Some("abcdef"));
        let (_, exact) = run(b"abcd\n", 100, 4, 5);
        assert!(exact.eof, "a budget that ends exactly at the end of file is not a cut-off");
    }

    #[test]
    fn verbatim_prefixes_are_removed_only_on_windows() {
        let simple = simplify(PathBuf::from(r"\\?\C:\Users\x"));
        assert_eq!(simple, if cfg!(windows) { PathBuf::from(r"C:\Users\x") } else { PathBuf::from(r"\\?\C:\Users\x") });
    }
}
