//! Archive extraction for managed engine downloads: zip and tar.gz (through a minimal ustar
//! reader), no shelling out to tar/unzip. Absolute paths, drive letters and `..` segments are
//! refused.

use std::fs;
use std::io::Read;
use std::path::Path;

const TAR_BLOCK: usize = 512;

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("refusing unsafe archive entry: {0}")]
    Unsafe(String),
    #[error("refusing unsafe binPath: {0}")]
    UnsafeBinPath(String),
    #[error("unsupported archive kind \"{0}\"")]
    Unsupported(String),
    #[error("{0}")]
    Other(String),
}

impl From<std::io::Error> for ExtractError {
    fn from(e: std::io::Error) -> Self {
        Self::Other(e.to_string())
    }
}

/// Rejects absolute paths, drive letters, and any `..` traversal segment.
pub fn is_safe_entry_path(name: &str) -> bool {
    let value = name.replace('\\', "/");
    let drive = value.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && value.as_bytes().get(1) == Some(&b':');
    !(value.is_empty() || value.starts_with('/') || drive || value.split('/').any(|s| s == ".."))
}

#[derive(Debug, PartialEq)]
pub struct TarEntry {
    pub name: String,
    pub dir: bool,
    pub mode: u32,
    pub data: Vec<u8>,
}

fn field(block: &[u8], start: usize, len: usize) -> String {
    let raw = &block[start..start + len];
    let end = raw.iter().position(|b| *b == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

fn octal(block: &[u8], start: usize, len: usize) -> usize {
    usize::from_str_radix(mixdog_js::js_trim(&field(block, start, len)), 8).unwrap_or(0)
}

/// Minimal ustar/GNU reader: regular files and directories, `prefix`, GNU long names, pax skipped.
pub fn parse_ustar(buffer: &[u8]) -> Vec<TarEntry> {
    let mut entries = Vec::new();
    let mut offset = 0;
    let mut long_name = String::new();
    while offset + TAR_BLOCK <= buffer.len() {
        let header = &buffer[offset..offset + TAR_BLOCK];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let name = field(header, 0, 100);
        let mode = octal(header, 100, 8) as u32;
        let size = octal(header, 124, 12);
        let typeflag = header[156];
        let prefix = field(header, 345, 155);
        let data_start = offset + TAR_BLOCK;
        let data = &buffer[data_start.min(buffer.len())..(data_start + size).min(buffer.len())];
        offset = data_start + size.div_ceil(TAR_BLOCK) * TAR_BLOCK;
        if typeflag == b'L' {
            long_name = String::from_utf8_lossy(data).trim_end_matches('\0').to_owned();
            continue;
        }
        if typeflag == b'x' || typeflag == b'g' {
            continue;
        }
        let full = if !long_name.is_empty() {
            std::mem::take(&mut long_name)
        } else if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if full.is_empty() {
            continue;
        }
        match typeflag {
            b'5' => entries.push(TarEntry { name: full.trim_end_matches('/').to_owned(), dir: true, mode, data: Vec::new() }),
            0 | b'0' => entries.push(TarEntry { name: full, dir: false, mode, data: data.to_vec() }),
            _ => {}
        }
    }
    entries
}

fn write_entry(dest: &Path, name: &str, data: &[u8], mode: u32) -> Result<String, ExtractError> {
    let target = dest.join(name);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&target, data)?;
    #[cfg(unix)]
    if mode != 0 {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777));
    }
    let _ = mode;
    Ok(name.to_owned())
}

pub fn extract_tar_gz(src: &Path, dest: &Path) -> Result<Vec<String>, ExtractError> {
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(fs::File::open(src)?).read_to_end(&mut raw)?;
    let mut written = Vec::new();
    for entry in parse_ustar(&raw) {
        if !is_safe_entry_path(&entry.name) {
            return Err(ExtractError::Unsafe(entry.name));
        }
        if entry.dir {
            fs::create_dir_all(dest.join(&entry.name))?;
            continue;
        }
        written.push(write_entry(dest, &entry.name, &entry.data, entry.mode)?);
    }
    Ok(written)
}

/// NuGet packaging files that must not land in a managed PSScriptAnalyzer dir.
pub fn is_nupkg_metadata(name: &str) -> bool {
    let value = name.replace('\\', "/");
    let value = value.trim_end_matches('/');
    if value.is_empty() {
        return false;
    }
    let base = value.rsplit('/').next().unwrap_or("");
    base == "[Content_Types].xml"
        || base == ".signature.p7s"
        || value == "_rels"
        || value.starts_with("_rels/")
        || value == "package"
        || value.starts_with("package/")
        || base.to_lowercase().ends_with(".nuspec")
}

pub fn extract_zip(src: &Path, dest: &Path, skip: impl Fn(&str) -> bool) -> Result<Vec<String>, ExtractError> {
    let mut archive = zip::ZipArchive::new(fs::File::open(src)?).map_err(|e| ExtractError::Other(e.to_string()))?;
    let mut written = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| ExtractError::Other(e.to_string()))?;
        let name = file.name().to_owned();
        if skip(&name) {
            continue;
        }
        if !is_safe_entry_path(&name) {
            return Err(ExtractError::Unsafe(name));
        }
        if file.is_dir() {
            fs::create_dir_all(dest.join(&name))?;
            continue;
        }
        let mode = file.unix_mode().unwrap_or(0);
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        written.push(write_entry(dest, &name, &data, mode)?);
    }
    Ok(written)
}

/// Extracts by manifest archive kind; `none` copies the single downloaded file to `bin_path`.
pub fn extract_archive(archive: &str, src: &Path, dest: &Path, bin_path: &str) -> Result<Vec<String>, ExtractError> {
    fs::create_dir_all(dest)?;
    match archive {
        "nupkg" => extract_zip(src, dest, is_nupkg_metadata),
        "zip" => extract_zip(src, dest, |_| false),
        "tar.gz" | "tgz" => extract_tar_gz(src, dest),
        "none" | "" => {
            let name = bin_path.replace('\\', "/");
            if !is_safe_entry_path(&name) {
                return Err(ExtractError::UnsafeBinPath(bin_path.to_owned()));
            }
            Ok(vec![write_entry(dest, &name, &fs::read(src)?, 0o755)?])
        }
        other => Err(ExtractError::Unsupported(other.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn tar_header(name: &str, size: usize, typeflag: u8) -> Vec<u8> {
        let mut h = vec![0u8; TAR_BLOCK];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[100..107].copy_from_slice(b"0000755");
        let s = format!("{size:011o}");
        h[124..135].copy_from_slice(s.as_bytes());
        h[156] = typeflag;
        h
    }

    fn tar(entries: &[(&str, &[u8], u8)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, data, flag) in entries {
            out.extend(tar_header(name, data.len(), *flag));
            out.extend(*data);
            out.extend(vec![0u8; (TAR_BLOCK - data.len() % TAR_BLOCK) % TAR_BLOCK]);
        }
        out.extend(vec![0u8; TAR_BLOCK * 2]);
        out
    }

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn paths_are_checked_before_anything_is_written() {
        for bad in ["../x", "/abs", "C:/x", "a/../b", "", "a\\..\\b"] {
            assert!(!is_safe_entry_path(bad), "{bad}");
        }
        assert!(is_safe_entry_path("dir/file.exe") && is_safe_entry_path("a\\b"));
    }

    #[test]
    fn tar_gz_extracts_files_and_dirs_and_refuses_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar.gz");
        std::fs::write(&archive, gz(&tar(&[("d/", b"", b'5'), ("d/bin", b"hello", b'0')]))).unwrap();
        let out = dir.path().join("out");
        assert_eq!(extract_archive("tar.gz", &archive, &out, "").unwrap(), ["d/bin"]);
        assert_eq!(std::fs::read(out.join("d/bin")).unwrap(), b"hello");
        std::fs::write(&archive, gz(&tar(&[("../evil", b"x", b'0')]))).unwrap();
        assert!(matches!(extract_archive("tar.gz", &archive, &dir.path().join("o2"), ""), Err(ExtractError::Unsafe(_))));
        assert!(!dir.path().join("evil").exists());
    }

    #[test]
    fn zip_skips_nupkg_metadata_and_none_copies_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.zip");
        {
            let mut w = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            for (name, data) in [("Mod/m.psd1", "m"), ("[Content_Types].xml", "x"), ("Mod.nuspec", "n"), ("_rels/.rels", "r")] {
                w.start_file(name, o).unwrap();
                w.write_all(data.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        let out = dir.path().join("o");
        assert_eq!(extract_archive("nupkg", &archive, &out, "").unwrap(), ["Mod/m.psd1"]);
        let single = dir.path().join("tool");
        std::fs::write(&single, b"bin").unwrap();
        let out = dir.path().join("o3");
        assert_eq!(extract_archive("none", &single, &out, "bin/tool").unwrap(), ["bin/tool"]);
        assert!(matches!(extract_archive("none", &single, &out, "../tool"), Err(ExtractError::UnsafeBinPath(_))));
        assert!(matches!(extract_archive("rar", &single, &out, ""), Err(ExtractError::Unsupported(_))));
    }
}
