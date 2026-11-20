//! What OCR needs on the machine, fetched on first use: the recognition program and each language's data.
//!
//! The program is a managed Tesseract 5 (the LSTM engine the old OCR ran as WebAssembly), downloaded from the pinned
//! release asset of the platform into `<dataDir>/office/ocr/engine/<version>`, its sha256 verified, unpacked beside the
//! final folder and published by one rename (the pattern of the voice runtime download). The language data is the files
//! the old engine downloaded: the gzipped `<lang>.traineddata` of `@tesseract.js-data/<lang>/4.0.0_best_int` on the same
//! CDN (or of a `langPath` the caller names), decompressed into `<dataDir>/office/ocr/languages/<lang>.traineddata`, where
//! the native engine reads them and where an earlier run's files already are.
//!
//! Nothing here retries or asks: a language already in the cache is not fetched, and a failure is the message the call
//! reports.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_rt::{CancellationToken, LaneTokens};
use sha2::{Digest, Sha256};

use super::lane_job;

/// The upper bound of what one archive may unpack to.
const MAX_UNPACKED_BYTES: u64 = 1 << 30;

/// How a release asset is packed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    /// One gzipped file: the program itself.
    Gzip,
    /// A zip archive of the program and the libraries beside it.
    Zip,
}

/// One pinned release asset of the recognition program.
#[derive(Debug, Clone, Copy)]
pub struct EngineAsset {
    /// `win32-x64`, `linux-x64`, `darwin-arm64` ...
    pub platform: &'static str,
    pub url: &'static str,
    /// Lowercase hex sha256 of the downloaded file.
    pub sha256: &'static str,
    pub format: ArchiveFormat,
    /// The program, relative to the folder the asset unpacks into.
    pub executable: &'static str,
}

/// The release the assets below belong to; its folder under `engine/`.
pub const ENGINE_VERSION: &str = "5.5.1";

/// The pinned assets, one per platform. An asset is listed here only with the sha256 of the file published as a release
/// asset; a platform without one reports that OCR is unavailable there.
pub const ENGINE_ASSETS: &[EngineAsset] = &[];

/// `<os>-<arch>` as the release assets are named.
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// The asset of `platform`.
pub fn asset_for<'a>(assets: &'a [EngineAsset], platform: &str) -> Option<&'a EngineAsset> {
    assets.iter().find(|asset| asset.platform == platform)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder().build().map_err(|error| error.to_string())?;
    let response = client.get(url).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Network error while fetching {url}. Response code: {}", response.status().as_u16()));
    }
    response.bytes().await.map(|bytes| bytes.to_vec()).map_err(|error| error.to_string())
}

/// A file of an unpacked asset: where it goes under the folder, its bytes, whether it is a program.
struct Unpacked {
    path: PathBuf,
    bytes: Vec<u8>,
    program: bool,
}

fn unpack(asset: &EngineAsset, archive: &[u8]) -> Result<Vec<Unpacked>, String> {
    match asset.format {
        ArchiveFormat::Gzip => {
            let mut bytes = Vec::new();
            GzDecoder::new(archive).take(MAX_UNPACKED_BYTES).read_to_end(&mut bytes).map_err(|error| format!("The OCR engine archive is damaged: {error}"))?;
            Ok(vec![Unpacked { path: PathBuf::from(asset.executable), bytes, program: true }])
        }
        ArchiveFormat::Zip => {
            let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|error| format!("The OCR engine archive is damaged: {error}"))?;
            let mut files = Vec::new();
            let mut total = 0u64;
            for index in 0..zip.len() {
                let mut entry = zip.by_index(index).map_err(|error| format!("The OCR engine archive is damaged: {error}"))?;
                // A name that would leave the folder is not unpacked.
                let Some(path) = entry.enclosed_name() else { continue };
                if entry.is_dir() {
                    continue;
                }
                total = total.saturating_add(entry.size());
                if total > MAX_UNPACKED_BYTES {
                    return Err("The OCR engine archive unpacks to more than it may".to_owned());
                }
                let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
                entry.read_to_end(&mut bytes).map_err(|error| format!("The OCR engine archive is damaged: {error}"))?;
                let program = path == Path::new(asset.executable);
                files.push(Unpacked { path, bytes, program });
            }
            if !files.iter().any(|file| file.program) {
                return Err(format!("The OCR engine archive has no {}", asset.executable));
            }
            Ok(files)
        }
    }
}

fn write_unpacked<P: WriteProof>(proof: &P, folder: &Path, files: &[Unpacked]) -> std::io::Result<()> {
    for file in files {
        let target = folder.join(&file.path);
        if let Some(parent) = target.parent() {
            mixdog_fsio::create_dir_all(proof, parent)?;
        }
        mixdog_fsio::write(proof, &target, &file.bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if file.program {
                mixdog_fsio::set_permissions(proof, &target, std::fs::Permissions::from_mode(0o755))?;
            }
        }
    }
    Ok(())
}

/// The recognition program of this machine: where it is installed, or downloaded, verified and installed first.
/// `engine_root` is `<dataDir>/office/ocr/engine`.
pub async fn ensure_engine(
    lanes: &LaneTokens,
    engine_root: &Path,
    assets: &[EngineAsset],
    platform: &str,
    cancel: &CancellationToken,
) -> Result<PathBuf, String> {
    let Some(asset) = asset_for(assets, platform) else {
        return Err(format!("OCR is not available on this platform ({platform}): no OCR engine is published for it"));
    };
    let folder = engine_root.join(ENGINE_VERSION);
    let program = folder.join(asset.executable);
    let probe = program.clone();
    if lane_job(lanes.durability_io, cancel, move |lane| mixdog_fsio::is_file(lane, &probe)).await? {
        return Ok(program);
    }
    let archive = download(asset.url).await?;
    let expected = asset.sha256.to_ascii_lowercase();
    let asset = *asset;
    let unpacked = lane_job(lanes.cpu_bulk, cancel, move |_| {
        let actual = hex(&Sha256::digest(&archive));
        if actual != expected {
            return Err(format!("The OCR engine download does not match its pinned checksum (expected {expected}, got {actual})"));
        }
        unpack(&asset, &archive)
    })
    .await??;
    let staging = engine_root.join(format!("{ENGINE_VERSION}.staging-{}", uuid::Uuid::new_v4()));
    let (stage, publish, final_program) = (staging.clone(), folder.clone(), program.clone());
    lane_job(lanes.durability_io, cancel, move |lane| -> Result<(), String> {
        let written = mixdog_fsio::create_dir_all(lane, &stage).and_then(|()| write_unpacked(lane, &stage, &unpacked));
        let published = written.and_then(|()| {
            if mixdog_fsio::is_file(lane, &final_program) {
                return Ok(());
            }
            mixdog_fsio::rename(lane, &stage, &publish)
        });
        // Another call may have published first: what it published is the program.
        let result = match published {
            Ok(()) => Ok(()),
            Err(_) if mixdog_fsio::is_file(lane, &final_program) => Ok(()),
            Err(error) => Err(format!("The OCR engine could not be installed: {error}")),
        };
        if mixdog_fsio::exists(lane, &stage).unwrap_or(false) {
            let _ = mixdog_fsio::remove_dir_all(lane, &stage);
        }
        result
    })
    .await??;
    Ok(program)
}

/// The languages of `languages` (`eng+kor`), each once.
fn language_names(languages: &str) -> Vec<&str> {
    let mut names: Vec<&str> = Vec::new();
    for name in languages.split('+') {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// A language name is what the engine names its data files by: letters, digits and underscores.
fn is_language_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_url(base: &str) -> bool {
    base.starts_with("http://") || base.starts_with("https://")
}

/// The decompressed data of one language: from the CDN (or the URL `lang_path` names) or from a local folder.
async fn fetch_language(lanes: &LaneTokens, name: &str, lang_path: Option<&str>, cancel: &CancellationToken) -> Result<Vec<u8>, String> {
    let file = format!("{name}.traineddata.gz");
    let data = match lang_path {
        Some(base) if !is_url(base) => {
            let path = Path::new(base).join(&file);
            lane_job(lanes.durability_io, cancel, move |lane| mixdog_fsio::read(lane, &path)).await?.map_err(|error| error.to_string())?
        }
        Some(base) => download(&format!("{}/{file}", base.trim_end_matches('/'))).await?,
        None => download(&format!("https://cdn.jsdelivr.net/npm/@tesseract.js-data/{name}/4.0.0_best_int/{file}")).await?,
    };
    if !data.starts_with(&[0x1f, 0x8b]) {
        return Ok(data);
    }
    lane_job(lanes.cpu_bulk, cancel, move |_| {
        let mut bytes = Vec::new();
        GzDecoder::new(data.as_slice()).take(MAX_UNPACKED_BYTES).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        Ok::<_, String>(bytes)
    })
    .await?
}

async fn ensure_language(lanes: LaneTokens, name: String, cache_path: PathBuf, lang_path: Option<String>, cancel: CancellationToken) -> Result<(), String> {
    if !is_language_name(&name) {
        return Err(format!("Invalid OCR language: {name}"));
    }
    let target = cache_path.join(format!("{name}.traineddata"));
    let probe = target.clone();
    if lane_job(lanes.durability_io, &cancel, move |lane| mixdog_fsio::is_file(lane, &probe)).await? {
        return Ok(());
    }
    let data = fetch_language(&lanes, &name, lang_path.as_deref(), &cancel).await?;
    // Written beside the file and renamed into place, so a reader never meets half a language.
    let partial = cache_path.join(format!("{name}.traineddata.{}.part", uuid::Uuid::new_v4()));
    lane_job(lanes.durability_io, &cancel, move |lane| -> Result<(), String> {
        let written = mixdog_fsio::write(lane, &partial, &data).and_then(|()| mixdog_fsio::rename(lane, &partial, &target));
        if written.is_err() {
            let _ = mixdog_fsio::remove_file(lane, &partial);
        }
        written.map_err(|error| format!("Failed to write {name}.traineddata to the cache: {error}"))
    })
    .await?
}

/// The data of every language of `languages` in `cache_path`, the missing ones downloaded together. A caller that
/// drops the future ends every download with it.
pub async fn ensure_languages(
    lanes: &LaneTokens,
    languages: &str,
    cache_path: &Path,
    lang_path: Option<&str>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let folder = cache_path.to_path_buf();
    lane_job(lanes.durability_io, cancel, move |lane| mixdog_fsio::create_dir_all(lane, &folder)).await?.map_err(|error| error.to_string())?;
    let mut downloads = tokio::task::JoinSet::new();
    for name in language_names(languages) {
        downloads.spawn(ensure_language(*lanes, name.to_owned(), cache_path.to_path_buf(), lang_path.map(str::to_owned), cancel.clone()));
    }
    while let Some(done) = downloads.join_next().await {
        done.map_err(|error| error.to_string())??;
    }
    Ok(())
}

/// The languages whose data is in the cache: the names before `.traineddata` or `.traineddata.gz`, in code-unit order.
pub fn cached_languages<P: ReadProof>(proof: &P, cache_path: &Path) -> Vec<String> {
    let Ok(entries) = mixdog_fsio::read_dir(proof, cache_path) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".traineddata").or_else(|| name.strip_suffix(".traineddata.gz"))?;
            (!stem.is_empty()).then(|| stem.to_owned())
        })
        .collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
}

/// Whether the program is installed already.
pub fn engine_installed<P: ReadProof>(proof: &P, engine_root: &Path, assets: &[EngineAsset], platform: &str) -> bool {
    asset_for(assets, platform).is_some_and(|asset| mixdog_fsio::is_file(proof, engine_root.join(ENGINE_VERSION).join(asset.executable)))
}
