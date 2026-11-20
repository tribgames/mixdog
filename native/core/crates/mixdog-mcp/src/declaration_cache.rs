//! Digest cache for plugin MCP declarations. Each fill fingerprints the exact file observations
//! used by the parser, including missing files that could change precedence or resolve an error.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use sha2::Digest;
use sha2::Sha256;

use crate::plugins::DeclarationFile;
use crate::plugins::PluginMcpDeclarations;
use crate::plugins::load_declarations_from;

struct Entry {
    files: HashMap<PathBuf, [u8; 32]>,
    value: PluginMcpDeclarations,
}

#[derive(Default)]
pub struct DeclarationCache {
    entries: Mutex<HashMap<PathBuf, Entry>>,
}

fn digest(file: &DeclarationFile) -> [u8; 32] {
    let mut hash = Sha256::new();
    match file {
        DeclarationFile::Missing => hash.update([0]),
        DeclarationFile::Unreadable(error) => {
            hash.update([1]);
            hash.update(error.as_bytes());
        }
        DeclarationFile::Bytes(bytes) => {
            hash.update([2]);
            hash.update(bytes);
        }
    }
    hash.finalize().into()
}

impl DeclarationCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load(&self, lane: &InLane<MaintenanceIo>, root: &Path) -> PluginMcpDeclarations {
        self.load_with(root, |path| DeclarationFile::read(lane, path))
    }

    fn load_with(&self, root: &Path, mut read: impl FnMut(&Path) -> DeclarationFile) -> PluginMcpDeclarations {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let mut observed = HashMap::<PathBuf, Arc<DeclarationFile>>::new();
        let mut file = |path: &Path| {
            if let Some(snapshot) = observed.get(path) {
                return Arc::clone(snapshot);
            }
            let snapshot = Arc::new(read(path));
            observed.insert(path.to_path_buf(), Arc::clone(&snapshot));
            snapshot
        };
        if let Some(entry) = entries.get(root)
            && entry.files.iter().all(|(path, expected)| digest(&file(path)) == *expected)
        {
            return entry.value.clone();
        }
        // Parse the same observations used for validation, and record only paths actually consulted by the parser.
        let mut files = HashMap::new();
        let value = load_declarations_from(root, |path| {
            let snapshot = file(path);
            files.entry(path.to_path_buf()).or_insert_with(|| digest(&snapshot));
            snapshot
        });
        entries.insert(root.to_path_buf(), Entry { files, value: value.clone() });
        value
    }

    /// Forgets a plugin that was removed.
    pub fn forget(&self, root: &Path) {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_during_a_fill_cannot_cache_an_old_declaration_under_new_bytes() {
        let cache = DeclarationCache::new();
        let root = Path::new("plugin");
        let mut edited = false;
        let mut read = |path: &Path| match path.file_name().and_then(|name| name.to_str()) {
            Some("plugin.json") if path.parent() == Some(root) => DeclarationFile::Bytes(br#"{"mcpServers":"servers.json"}"#.to_vec()),
            Some("servers.json") if !edited => {
                edited = true;
                DeclarationFile::Bytes(br#"{"before":{"command":"old"}}"#.to_vec())
            }
            Some("servers.json") => DeclarationFile::Bytes(br#"{"after":{"command":"new"}}"#.to_vec()),
            _ => DeclarationFile::Missing,
        };

        assert_eq!(cache.load_with(root, &mut read).servers[0].key, "before");
        assert_eq!(cache.load_with(root, &mut read).servers[0].key, "after");
    }
}
