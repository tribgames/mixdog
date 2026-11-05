//! Digest cache for plugin MCP declarations: a plugin's declaration is re-read only when a file
//! it was built from (or could have been built from) changed. The digest covers the manifests,
//! `.mcp.json`, every file the manifest points at and every file a result came from, so adding,
//! editing or removing any of them invalidates the entry.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use crate::plugins::MANIFEST_FILES;
use crate::plugins::PluginMcpDeclarations;
use crate::plugins::load_declarations;
use crate::plugins::manifest;
use crate::plugins::resolve_contained;

struct Entry {
    files: Vec<PathBuf>,
    digest: [u8; 32],
    value: PluginMcpDeclarations,
}

#[derive(Default)]
pub struct DeclarationCache {
    entries: Mutex<HashMap<PathBuf, Entry>>,
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn digest_of(files: &[PathBuf]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.to_string_lossy().as_bytes());
        match std::fs::read(file) {
            Ok(bytes) => {
                hasher.update([1]);
                hasher.update(bytes);
            }
            Err(_) => hasher.update([0]),
        }
    }
    hasher.finalize().into()
}

/// The files a declaration for `root` depends on, whether or not they exist yet.
fn candidate_files(lane: &InLane<MaintenanceIo>, root: &Path) -> BTreeSet<PathBuf> {
    let mut files: BTreeSet<PathBuf> = MANIFEST_FILES.iter().map(|f| root.join(f)).collect();
    files.insert(root.join(".mcp.json"));
    let (_, doc) = manifest(lane, root);
    let pointed: Vec<&Value> = match doc.get("mcpServers") {
        Some(Value::Array(members)) => members.iter().collect(),
        Some(single) => vec![single],
        None => Vec::new(),
    };
    for text in pointed.into_iter().filter_map(Value::as_str) {
        if let Some(path) = resolve_contained(root, text) {
            files.insert(path);
        }
    }
    files
}

impl DeclarationCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The declarations of the plugin at `root`, re-read only when its digest changed.
    pub fn load(&self, lane: &InLane<MaintenanceIo>, root: &Path) -> PluginMcpDeclarations {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(root)
            && digest_of(&entry.files) == entry.digest
        {
            return entry.value.clone();
        }
        let value = load_declarations(lane, root);
        let mut files = candidate_files(lane, root);
        files.extend(value.servers.iter().map(|s| s.source.clone()));
        files.extend(value.errors.iter().map(|e| e.source.clone()));
        let files: Vec<PathBuf> = files.into_iter().collect();
        let digest = digest_of(&files);
        entries.insert(root.to_path_buf(), Entry { files, digest, value: value.clone() });
        value
    }

    /// Forgets a plugin that was removed.
    pub fn forget(&self, root: &Path) {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(root);
    }
}