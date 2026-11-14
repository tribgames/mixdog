//! The server payload: the `mixdogd` binary built for the server's platform with its JS runtime,
//! in one `bundle.tgz`. A desktop ships one bundle per supported server platform next to a
//! manifest (`servers.json`, written by scripts/stage-core.mjs); the manifest's `build` is one
//! value for the whole release, so the version directory name `<version>-<build>` is known
//! before the server's platform is. The directory is `SshEnv.server_cores_dir`: nothing here
//! looks for it.

use std::path::Path;
use std::path::PathBuf;

use crate::install_wire::BootstrapCode;
use crate::install_wire::RemoteBootstrapError;
use crate::install_wire::ServerManifest;
use crate::install_wire::ServerPlatform;
use crate::install_wire::is_safe_segment;
use crate::install_wire::sha256_hex;

/// What one install uploads: the bundle of the server's platform, checked against the manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPayload {
    /// The wire form: a gzip tar of `mixdogd` and `payload/`.
    pub bundle: PathBuf,
    /// sha256 of the `mixdogd` binary inside the bundle; the server checks it again when it installs.
    pub sha256: String,
    /// sha256 of the wire form, which the bootstrap checks before it unpacks anything.
    pub bundle_sha256: String,
    pub version: String,
    pub build: String,
}

impl InstallPayload {
    /// `<version>-<build>`: the version directory name on the server.
    pub fn install_id(&self) -> String {
        format!("{}-{}", self.version, self.build)
    }

    /// The payload of `platform` as the manifest names it, without touching the bundle.
    pub fn resolve(dir: &Path, manifest: &ServerManifest, platform: ServerPlatform) -> Result<Self, RemoteBootstrapError> {
        let key = platform.key();
        let local = |message: String| RemoteBootstrapError::new(BootstrapCode::LocalPayload, message);
        let entry = manifest
            .binaries
            .get(&key)
            .ok_or_else(|| local(format!("This desktop ships no Mixdog server runtime for {key}.")))?;
        let bundle = entry
            .bundle
            .as_ref()
            .filter(|bundle| is_safe_segment(&bundle.file) && !bundle.sha256.is_empty())
            .ok_or_else(|| local(format!("The server runtime manifest has no bundle for {key}.")))?;
        Ok(Self {
            bundle: dir.join(&key).join(&bundle.file),
            sha256: entry.sha256.clone(),
            bundle_sha256: bundle.sha256.clone(),
            version: manifest.version.clone(),
            build: manifest.build.clone(),
        })
    }

    /// The payload of `platform` from the release staged in `server_cores_dir`: its manifest is
    /// read and checked. The bundle itself is not touched: only an install uploads it, through
    /// [`InstallPayload::read_archive`].
    pub fn load<P: mixdog_fsio::ReadProof>(
        proof: &P,
        server_cores_dir: &Path,
        platform: ServerPlatform,
    ) -> Result<Self, RemoteBootstrapError> {
        let manifest = ServerManifest::load(proof, server_cores_dir)?;
        Self::resolve(server_cores_dir, &manifest, platform)
    }

    /// The bundle's bytes (read on demand, for an upload), checked against `bundle_sha256`.
    pub fn read_archive<P: mixdog_fsio::ReadProof>(&self, proof: &P) -> Result<Vec<u8>, RemoteBootstrapError> {
        let data = mixdog_fsio::read(proof, &self.bundle).map_err(|e| {
            RemoteBootstrapError::new(
                BootstrapCode::LocalPayload,
                format!("{} could not be read: {e}", self.bundle.display()),
            )
        })?;
        if sha256_hex(&data) != self.bundle_sha256 {
            return Err(RemoteBootstrapError::new(
                BootstrapCode::LocalPayload,
                format!("{} does not match the server runtime manifest.", self.bundle.display()),
            ));
        }
        Ok(data)
    }
}
