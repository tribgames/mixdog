//! Planning (SM §11.1, FORMAT.md §10.3): drivers add items and shared sources to one
//! `PlanSink`, which becomes the sorted `manifest.json`.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKey;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::MANIFEST_FORMAT;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::Root;
use mixdog_store::schema::migration::SharedSource;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::migration::Target;

use crate::durable;
use crate::error::Blocked;
use crate::error::Result;
use crate::framework::MigrationRoots;

/// Every byte outside `[A-Za-z0-9._-]` as `%XX` (FORMAT.md §10.1).
pub fn escape_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for b in key.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn root_name(root: Root) -> &'static str {
    match root {
        Root::Data => "data",
        Root::Home => "home",
        Root::Profile => "profile",
    }
}

/// `retire/<root>/<path>`.
pub fn retire_key(root: Root, rel: &str) -> String {
    format!("retire/{}/{rel}", root_name(root))
}

/// `retain/<root>/<path>`.
pub fn retain_key(root: Root, rel: &str) -> String {
    format!("retain/{}/{rel}", root_name(root))
}

/// A manifest item; `sources` are sorted here.
pub fn item(
    key: &str,
    group: KindGroup,
    kind: ItemKind,
    contract: Contract,
    mut sources: Vec<SourceFile>,
    target: Option<Target>,
) -> Result<ManifestItem> {
    sources.sort_by(|a, b| (a.root, &a.path).cmp(&(b.root, &b.path)));
    Ok(ManifestItem {
        key: ItemKey::try_from(key).map_err(Blocked::journal)?,
        group,
        kind,
        contract,
        sources,
        target,
    })
}

/// Items and shared sources under construction.
pub struct PlanSink {
    roots: MigrationRoots,
    items: BTreeMap<String, ManifestItem>,
    shared: BTreeMap<(Root, String), (SourceFile, BTreeSet<String>)>,
}

impl PlanSink {
    pub fn new(roots: &MigrationRoots) -> Self {
        Self {
            roots: roots.clone(),
            items: BTreeMap::new(),
            shared: BTreeMap::new(),
        }
    }

    /// A source file entry: size and SHA-256 of the file as it is now.
    pub fn source(&self, root: Root, rel: &str, secret: bool) -> Result<SourceFile> {
        let path = self.roots.resolve(root, rel)?;
        let (size, sha256) = durable::hash_file(&path)?;
        Ok(SourceFile {
            root,
            path: rel.to_string(),
            size,
            sha256,
            secret,
        })
    }

    pub fn add_item(&mut self, item: ManifestItem) -> Result<()> {
        let key = item.key.as_str().to_string();
        if self.items.insert(key.clone(), item).is_some() {
            return Err(Blocked::journal(format!("two items plan the key {key}")));
        }
        Ok(())
    }

    /// Records that `consumer` reads the shared file `file`.
    pub fn add_shared(&mut self, file: SourceFile, consumer: &str) {
        self.shared
            .entry((file.root, file.path.clone()))
            .or_insert_with(|| (file, BTreeSet::new()))
            .1
            .insert(consumer.to_string());
    }

    pub fn has_item(&self, key: &str) -> bool {
        self.items.contains_key(key)
    }

    pub fn items(&self) -> impl Iterator<Item = &ManifestItem> {
        self.items.values()
    }

    /// The session ids planned so far.
    pub fn session_ids(&self) -> impl Iterator<Item = &str> {
        self.items.keys().filter_map(|k| k.strip_prefix("session/"))
    }

    pub fn into_manifest(self, roots: &MigrationRoots) -> Manifest {
        Manifest {
            format: MANIFEST_FORMAT,
            roots: roots.to_schema(),
            items: self.items.into_values().collect(),
            shared: self
                .shared
                .into_values()
                .map(|(file, consumers)| SharedSource {
                    file,
                    consumers: consumers.into_iter().collect(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_escape_every_other_byte() {
        assert_eq!(
            escape_key("retire/data/sessions/a b.json"),
            "retire%2Fdata%2Fsessions%2Fa%20b.json"
        );
    }
}
