//! The PowerShell scripts that implement the COM operations. They are embedded in the binary and written once under
//! `<dataDir>/office/com/<first 16 hex of their sha256>/` with their own file names, since the hosts dot-source each
//! other from `$PSScriptRoot`. Their bytes are verified before every spawn, so a copy that was edited, truncated or
//! removed is written again.

use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_fsio::WriteProof;
use sha2::Digest;
use sha2::Sha256;

pub(crate) const HOST_SCRIPT: &str = "office-com-host.ps1";
pub(crate) const SESSION_HOST_SCRIPT: &str = "office-com-session-host.ps1";

/// Numbers the staging files of this process.
static NEXT_STAGING: AtomicU64 = AtomicU64::new(0);

/// Every script, by the file name the hosts dot-source it under.
const SCRIPTS: [(&str, &[u8]); 4] = [
    (HOST_SCRIPT, include_bytes!("../assets/office-com-host.ps1")),
    (SESSION_HOST_SCRIPT, include_bytes!("../assets/office-com-session-host.ps1")),
    ("office-com-cleanup.ps1", include_bytes!("../assets/office-com-cleanup.ps1")),
    ("office-word-formatting.ps1", include_bytes!("../assets/office-word-formatting.ps1")),
];

/// The first 16 hex characters of the sha256 over the scripts' names and bytes.
pub(crate) fn digest() -> &'static str {
    static DIGEST: OnceLock<String> = OnceLock::new();
    DIGEST.get_or_init(|| {
        let mut hash = Sha256::new();
        for (name, bytes) in SCRIPTS {
            hash.update(name.as_bytes());
            hash.update([0]);
            hash.update(bytes);
            hash.update([0]);
        }
        hash.finalize().iter().take(8).map(|byte| format!("{byte:02x}")).collect()
    })
}

/// The folder the scripts live in under `data_dir`.
pub(crate) fn directory(data_dir: &Path) -> PathBuf {
    data_dir.join("office").join("com").join(digest())
}

/// Makes sure every script is in [`directory`] with exactly the embedded bytes and returns the folder. Runs inside a
/// lane job (`proof`).
pub(crate) fn ensure<P: WriteProof>(proof: &P, data_dir: &Path) -> io::Result<PathBuf> {
    let dir = directory(data_dir);
    mixdog_fsio::create_dir_all(proof, &dir)?;
    for (name, bytes) in SCRIPTS {
        let path = dir.join(name);
        if mixdog_fsio::read(proof, &path).is_ok_and(|found| found == bytes) {
            continue;
        }
        // Two first calls can write at once: each writes its own staging file, and either rename leaves the same bytes.
        let serial = NEXT_STAGING.fetch_add(1, Ordering::Relaxed);
        let staging = dir.join(format!("{name}.{}.{serial}.tmp", std::process::id()));
        mixdog_fsio::write(proof, &staging, bytes)?;
        if let Err(error) = mixdog_fsio::rename(proof, &staging, &path) {
            let _ = mixdog_fsio::remove_file(proof, &staging);
            return Err(error);
        }
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mixdog-office-com-{name}-{}", std::process::id()));
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
        dir
    }

    #[test]
    fn the_folder_is_named_for_the_first_sixteen_hex_characters_of_the_scripts_digest() {
        let dir = directory(Path::new("data"));
        let name = dir.file_name().and_then(|name| name.to_str()).expect("a name");
        assert_eq!(name.len(), 16);
        assert!(name.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(dir.ends_with(Path::new("office").join("com").join(name)));
    }

    #[test]
    fn a_missing_edited_or_truncated_script_is_written_again_with_the_embedded_bytes() {
        let data = scratch("ensure");
        let dir = ensure(&Unlaned, &data).expect("first write");
        for (name, bytes) in SCRIPTS {
            assert_eq!(mixdog_fsio::read(&Unlaned, dir.join(name)).expect("written"), bytes);
        }
        mixdog_fsio::write(&Unlaned, dir.join(HOST_SCRIPT), b"edited").expect("edit");
        mixdog_fsio::remove_file(&Unlaned, dir.join("office-com-cleanup.ps1")).expect("remove");
        assert_eq!(ensure(&Unlaned, &data).expect("second write"), dir);
        for (name, bytes) in SCRIPTS {
            assert_eq!(mixdog_fsio::read(&Unlaned, dir.join(name)).expect("restored"), bytes);
        }
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &data);
    }
}
