//! The server payload: the `mixdogd` binary built for the server's platform with its JS runtime, in one gzip tar that is an
//! asset of this version's GitHub release. A desktop carries only the manifest (`servers.json`, written by
//! scripts/stage-core.mjs, in `SshEnv.server_cores_dir`): for each supported `<os>-<arch>` the target, the asset's name, length
//! and sha256, and the sha256 of the binary inside. The manifest's `build` is one value for the whole release, so the version
//! directory name `<version>-<build>` is known before the server's platform is. Where the bytes come from is
//! [`crate::bundle_source`].

use crate::install_wire::BootstrapCode;
use crate::install_wire::RemoteBootstrapError;
use crate::install_wire::ServerManifest;
use crate::install_wire::ServerPlatform;
use crate::install_wire::is_safe_segment;
use crate::install_wire::sha256_hex;

/// What one install uploads: the bundle of the server's platform as the manifest names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPayload {
    /// `<os>-<arch>`.
    pub key: String,
    /// The release asset that is the bundle (the wire form: a gzip tar of `mixdogd` and `payload/`).
    pub asset: String,
    /// Length and sha256 of the bundle: every copy is held to them, and the server checks the digest again before it unpacks.
    pub size: u64,
    pub bundle_sha256: String,
    /// sha256 of the `mixdogd` binary inside the bundle; the server checks it again when it installs.
    pub sha256: String,
    pub version: String,
    pub build: String,
}

impl InstallPayload {
    /// `<version>-<build>`: the version directory name on the server.
    pub fn install_id(&self) -> String {
        format!("{}-{}", self.version, self.build)
    }

    /// The payload of `platform` as the manifest names it, without looking for its bytes.
    pub fn resolve(manifest: &ServerManifest, platform: ServerPlatform) -> Result<Self, RemoteBootstrapError> {
        let key = platform.key();
        let local = |message: String| RemoteBootstrapError::new(BootstrapCode::LocalPayload, message);
        let entry = manifest.binaries.get(&key).ok_or_else(|| local(format!("This desktop ships no Mixdog server runtime for {key}.")))?;
        if entry.target != platform.target() {
            return Err(local(format!("The server runtime manifest names a runtime built for {} for {key}.", entry.target)));
        }
        let bundle = entry
            .bundle
            .as_ref()
            .filter(|bundle| is_safe_segment(&bundle.asset) && !bundle.sha256.is_empty() && bundle.size > 0)
            .ok_or_else(|| local(format!("The server runtime manifest has no bundle for {key}.")))?;
        Ok(Self {
            key,
            asset: bundle.asset.clone(),
            size: bundle.size,
            bundle_sha256: bundle.sha256.clone(),
            sha256: entry.sha256.clone(),
            version: manifest.version.clone(),
            build: manifest.build.clone(),
        })
    }

    /// The one rule every copy of the bundle is held to, whether it was downloaded, kept from an earlier install or brought by
    /// hand: the length and sha256 the manifest lists. The error says how a copy differs.
    pub fn check(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() as u64 != self.size {
            return Err(format!("it is {} bytes, the release lists {}", bytes.len(), self.size));
        }
        if sha256_hex(bytes) != self.bundle_sha256 {
            return Err("its checksum is not the one the release lists".to_owned());
        }
        Ok(())
    }
}
