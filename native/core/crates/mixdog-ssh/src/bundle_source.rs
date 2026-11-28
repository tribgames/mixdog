//! Where the bytes of a server bundle come from when an install uploads one: the copy staged beside the manifest (a development
//! tree; a package carries the manifest alone), this PC's cache, the import folder a person fills by hand, else the asset of
//! this version's GitHub release. Every copy is held to the manifest the app carries
//! ([`InstallPayload::check`]) before it is used or kept, and nothing downloaded beside the archive is read. The server never
//! reaches the release: the bytes go up the ssh connection of the install.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_fsio::Unlaned;

use crate::context::SshEnv;
use crate::install_payload::InstallPayload;
use crate::install_wire::{BootstrapCode, RemoteBootstrapError};
use crate::mixdog_config::{data_dir, publish_file};

#[cfg(test)]
#[path = "bundle_source_tests.rs"]
mod bundle_source_tests;

/// The repository whose release `v<version>` holds the server bundles.
pub const RELEASE_REPOSITORY: &str = "tribgames/mixdog";
/// The folder under the core's data folder that keeps the bundles: one folder per `<version>-<build>`, and [`IMPORT_FOLDER`].
pub const CACHE_FOLDER: &str = "server-runtimes";
/// Where a person puts a bundle they downloaded elsewhere, under its asset name.
pub const IMPORT_FOLDER: &str = "import";
/// A download that brings no byte for this long is given up: a dead connection would hold the install forever.
const STALL: Duration = Duration::from_secs(60);

/// The release page of `version`, where a person finds its assets.
pub fn release_page(version: &str) -> String {
    format!("https://github.com/{RELEASE_REPOSITORY}/releases/tag/v{version}")
}

/// Where the release serves a payload's asset.
pub fn asset_url(payload: &InstallPayload) -> String {
    format!("https://github.com/{RELEASE_REPOSITORY}/releases/download/v{}/{}", payload.version, payload.asset)
}

/// Downloads a release asset.
#[async_trait]
pub trait AssetFetcher: Send + Sync {
    /// The body of `url`; an answer that is not a success, or that carries more than `length` bytes, is an error.
    async fn fetch(&self, url: &str, length: u64) -> Result<Vec<u8>, String>;
}

/// HTTPS from this PC, through the proxy its environment or system names.
pub struct HttpFetcher;

#[async_trait]
impl AssetFetcher for HttpFetcher {
    async fn fetch(&self, url: &str, length: u64) -> Result<Vec<u8>, String> {
        let client = reqwest::Client::builder().user_agent(concat!("mixdog/", env!("CARGO_PKG_VERSION"))).build().map_err(|error| describe(&error))?;
        fetch_with(&client, url, length).await
    }
}

/// [`AssetFetcher::fetch`] over `client`.
async fn fetch_with(client: &reqwest::Client, url: &str, length: u64) -> Result<Vec<u8>, String> {
    let stalled = |_| format!("no data arrived for {} s", STALL.as_secs());
    let failed = |error: reqwest::Error| describe(&error.without_url());
    let mut response = mixdog_rt::time::timeout(STALL, client.get(url).send()).await.map_err(stalled)?.map_err(failed)?;
    if !response.status().is_success() {
        return Err(format!("the release answered HTTP {}", response.status().as_u16()));
    }
    let longer = || format!("the answer is longer than the {length} bytes the release lists");
    if response.content_length().is_some_and(|advertised| advertised > length) {
        return Err(longer());
    }
    // The length is the manifest's, so the body is held once at its full size instead of grown and copied as it arrives.
    let mut body = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    while let Some(chunk) = mixdog_rt::time::timeout(STALL, response.chunk()).await.map_err(stalled)?.map_err(failed)? {
        if (body.len() + chunk.len()) as u64 > length {
            return Err(longer());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// An error and its causes, as one line.
fn describe(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();
    while let Some(next) = cause {
        let line = next.to_string();
        if !text.contains(&line) {
            text.push_str(": ");
            text.push_str(&line);
        }
        cause = next.source();
    }
    text
}

/// What this PC holds of a payload's bundle.
pub enum Held {
    /// A copy that passed the check.
    Bytes(Vec<u8>),
    /// None. `refused` are the files of the asset's name, staged or brought, and how each fails the check.
    Missing { refused: Vec<(PathBuf, String)> },
}

/// Where this PC keeps the bundles it downloaded and the ones a person brought.
#[derive(Clone, Debug)]
pub struct BundleCache {
    root: PathBuf,
}

impl BundleCache {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// [`CACHE_FOLDER`] under the core's data folder: outside the application, which carries the manifest only.
    pub fn of(env: &SshEnv) -> Self {
        Self::new(data_dir(env).join(CACHE_FOLDER))
    }

    pub fn import_dir(&self) -> PathBuf {
        self.root.join(IMPORT_FOLDER)
    }

    fn cached(&self, payload: &InstallPayload) -> PathBuf {
        self.root.join(payload.install_id()).join(&payload.asset)
    }

    /// The copy of `payload`'s bundle this PC holds: the one staged beside the manifest in `staged`, else the cached one, else
    /// the one in the import folder, which moves into the cache. A copy that fails the check is not used and is left where it is.
    pub fn held<P: mixdog_fsio::ReadProof>(&self, proof: &P, staged: &Path, payload: &InstallPayload) -> Held {
        let mut refused = Vec::new();
        let beside = staged.join(&payload.asset);
        if let Ok(bytes) = mixdog_fsio::read(proof, &beside) {
            match payload.check(&bytes) {
                Ok(()) => return Held::Bytes(bytes),
                Err(reason) => refused.push((beside, reason)),
            }
        }
        if let Ok(bytes) = mixdog_fsio::read(proof, self.cached(payload))
            && payload.check(&bytes).is_ok()
        {
            return Held::Bytes(bytes);
        }
        let imported = self.import_dir().join(&payload.asset);
        let Ok(bytes) = mixdog_fsio::read(proof, &imported) else { return Held::Missing { refused } };
        if let Err(reason) = payload.check(&bytes) {
            refused.push((imported, reason));
            return Held::Missing { refused };
        }
        // The import goes only once the cache holds it: a failure leaves the person's file for the next install.
        if self.keep(payload, &bytes).is_ok() {
            let _ = mixdog_fsio::remove_file(&Unlaned, &imported);
        }
        Held::Bytes(bytes)
    }

    /// Keeps `bytes`, which passed the check, as the cached copy of `payload`'s bundle (replaced in one step), then removes
    /// the folders of every other build: this desktop uploads only its own.
    pub fn keep(&self, payload: &InstallPayload, bytes: &[u8]) -> io::Result<()> {
        publish_file(&self.cached(payload), bytes)?;
        let current = payload.install_id();
        if let Ok(entries) = mixdog_fsio::read_dir(&Unlaned, &self.root) {
            for entry in entries.flatten() {
                let (name, path) = (entry.file_name(), entry.path());
                if name != IMPORT_FOLDER && name != current.as_str() && mixdog_fsio::is_dir(&Unlaned, &path) {
                    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &path);
                }
            }
        }
        Ok(())
    }
}

/// A bundle this PC does not hold: downloaded from the release when the upload starts.
pub struct ReleaseFetch {
    payload: InstallPayload,
    cache: BundleCache,
    fetcher: Arc<dyn AssetFetcher>,
    refused: Vec<(PathBuf, String)>,
}

impl ReleaseFetch {
    pub fn new(payload: InstallPayload, cache: BundleCache, fetcher: Arc<dyn AssetFetcher>, refused: Vec<(PathBuf, String)>) -> Self {
        Self { payload, cache, fetcher, refused }
    }

    pub fn url(&self) -> String {
        asset_url(&self.payload)
    }

    /// The bundle from the release, checked against the manifest and kept for the next install. A failure changes nothing on
    /// this PC: it is `local-payload`, naming the asset and the import folder a person can bring it to.
    pub async fn bytes(self, log: &(dyn Fn(&str) + Sync)) -> Result<Vec<u8>, RemoteBootstrapError> {
        let fetched = self.fetcher.fetch(&self.url(), self.payload.size).await;
        let bytes = match fetched.and_then(|bytes| self.payload.check(&bytes).map(|()| bytes)) {
            Ok(bytes) => bytes,
            Err(reason) => return Err(self.unavailable(&reason)),
        };
        if let Err(error) = self.cache.keep(&self.payload, &bytes) {
            log(&format!("the downloaded server runtime {} could not be kept: {error}", self.payload.asset));
        }
        Ok(bytes)
    }

    fn unavailable(&self, reason: &str) -> RemoteBootstrapError {
        let payload = &self.payload;
        let refused: String = self.refused.iter().map(|(file, why)| format!(" {} is not that file: {why}.", file.display())).collect();
        RemoteBootstrapError::new(
            BootstrapCode::LocalPayload,
            format!(
                "The Mixdog server runtime for {} could not be downloaded from {}: {reason}. Nothing on the server was changed.{refused} \
                 To install it without the download, get {} from {} on a computer that can, put it in {}, and connect again.",
                payload.key,
                self.url(),
                payload.asset,
                release_page(&payload.version),
                self.cache.import_dir().display(),
            ),
        )
    }
}
