//! The registered faces, in registration order, grouped by family name as `GlobalFonts` groups them.
//!
//! A family is found by its exact registered name (the match is case-sensitive: `arial` is not `Arial`). Faces of a
//! family keep the order they were registered in, which decides ties between styles of equal score. A face
//! registered under an alias takes that name for its family, whatever its name table says. The registry is built by
//! the caller, then shared behind an `Arc` and not changed.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_fsio::ReadProof;

use crate::face::Face;
use crate::face::FontError;
use crate::face::FontStyle;

/// The position of a face in registration order.
pub type FaceId = usize;

/// How deep `register_dir` follows folders.
const MAX_DEPTH: usize = 8;

#[derive(Debug)]
struct Registered {
    face: Arc<Face>,
    family: String,
    path: Option<PathBuf>,
}

/// One family as `GlobalFonts.families` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyEntry {
    pub family: String,
    /// The style of each face, in registration order.
    pub styles: Vec<FontStyle>,
}

#[derive(Debug, Default)]
pub struct Registry {
    faces: Vec<Registered>,
    /// Family names in the order their first face was registered, each with its face ids in registration order.
    families: Vec<(String, Vec<FaceId>)>,
    by_name: HashMap<String, usize>,
    aliases: HashMap<String, String>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a face under `family` (its own family name when `None`). A face already registered from the same
    /// file under the same family is not added again; its id is returned.
    pub fn register(&mut self, face: Arc<Face>, family: Option<&str>, path: Option<&Path>) -> FaceId {
        let family = family.map_or_else(|| face.family.clone(), str::to_owned);
        if let Some(path) = path {
            let same = self.faces.iter().position(|known| {
                known.family == family && known.path.as_deref() == Some(path) && known.face.index() == face.index()
            });
            if let Some(id) = same {
                return id;
            }
        }
        let id = self.faces.len();
        self.faces.push(Registered { face, family: family.clone(), path: path.map(Path::to_path_buf) });
        match self.by_name.get(&family) {
            Some(slot) => self.families[*slot].1.push(id),
            None => {
                self.by_name.insert(family.clone(), self.families.len());
                self.families.push((family, vec![id]));
            }
        }
        id
    }

    /// `GlobalFonts.registerFromPath(path, family)`: the first face of the file, kept in memory.
    pub fn register_file<P: ReadProof>(&mut self, proof: &P, path: &Path, family: Option<&str>) -> Result<FaceId, FontError> {
        let face = Face::from_file(proof, path)?;
        Ok(self.register(Arc::new(face), family, Some(path)))
    }

    /// Registers the first face of the file at `path` from its bytes without keeping them: the face reads the file
    /// when it is first used.
    pub fn register_described(&mut self, path: &Path, data: &[u8], family: Option<&str>) -> Result<FaceId, FontError> {
        let face = Face::described(path, data)?;
        Ok(self.register(Arc::new(face), family, Some(path)))
    }

    fn scan_file<P: ReadProof>(&mut self, proof: &P, path: &Path) -> Result<FaceId, FontError> {
        let bytes = mixdog_fsio::read(proof, path).map_err(|error| FontError::Unreadable(format!("{}: {error}", path.display())))?;
        self.register_described(path, &bytes, None)
    }

    /// `GlobalFonts.loadFontsFromDir(dir)`: every font file of the folder and its sub-folders, described and not kept in
    /// memory, in the order of their upper-cased names (the order NTFS lists a folder in). Files that are not fonts are skipped. Returns how many
    /// faces were registered.
    pub fn register_dir<P: ReadProof>(&mut self, proof: &P, dir: &Path) -> usize {
        let mut files = Vec::new();
        collect_font_files(proof, dir, 0, &mut files);
        files.into_iter().filter(|path| self.scan_file(proof, path).is_ok()).count()
    }

    /// `GlobalFonts.setAlias(font_name, alias)`: `alias` resolves to the family `font_name`. An alias never hides a
    /// registered family of the same name.
    pub fn set_alias(&mut self, font_name: &str, alias: &str) {
        self.aliases.insert(alias.to_owned(), font_name.to_owned());
    }

    /// The face with this id.
    pub fn face(&self, id: FaceId) -> &Arc<Face> {
        &self.faces[id].face
    }

    /// The family a face is registered under.
    pub fn family_of(&self, id: FaceId) -> &str {
        &self.faces[id].family
    }

    /// The file a face was registered from, when it came from one.
    pub fn path_of(&self, id: FaceId) -> Option<&Path> {
        self.faces[id].path.as_deref()
    }

    pub fn len(&self) -> usize {
        self.faces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.faces.is_empty()
    }

    /// The ids of a family's faces by exact name (an alias resolves to the family it names).
    pub fn family(&self, name: &str) -> Option<&[FaceId]> {
        let slot = self.by_name.get(name).or_else(|| self.aliases.get(name).and_then(|target| self.by_name.get(target)))?;
        Some(&self.families[*slot].1)
    }

    /// The family of the first registered face: what a name that is not registered resolves to.
    pub fn default_family(&self) -> Option<&[FaceId]> {
        self.families.first().map(|(_, ids)| ids.as_slice())
    }

    /// `GlobalFonts.families`.
    pub fn families(&self) -> Vec<FamilyEntry> {
        self.families
            .iter()
            .map(|(family, ids)| FamilyEntry { family: family.clone(), styles: ids.iter().map(|id| self.faces[*id].face.style).collect() })
            .collect()
    }

    /// The registered family names in registration order.
    pub fn family_names(&self) -> impl Iterator<Item = &str> {
        self.families.iter().map(|(family, _)| family.as_str())
    }
}

fn is_font_file(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| {
        ["ttf", "otf", "ttc", "otc"].iter().any(|known| extension.eq_ignore_ascii_case(known))
    })
}

/// The font files under `dir`, a folder's entries sorted by upper-cased name before any is entered.
fn collect_font_files<P: ReadProof>(proof: &P, dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = mixdog_fsio::read_dir(proof, dir) else { return };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_uppercase());
    for entry in entries {
        let path = entry.path();
        let Ok(kind) = entry.file_type(proof) else { continue };
        if kind.is_dir() {
            if depth < MAX_DEPTH {
                collect_font_files(proof, &path, depth + 1, out);
            }
        } else if (kind.is_file() || (kind.is_symlink() && mixdog_fsio::is_file(proof, &path))) && is_font_file(&path) {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::face::FontStyle;
    use crate::face::Slant;

    /// A face with only the fields the registry reads (no font data): tests only.
    fn stub(family: &str, weight: u16, slant: Slant) -> Arc<Face> {
        let mut face = Face::stub(family);
        face.style = FontStyle { weight, width: 5, slant };
        Arc::new(face)
    }

    #[test]
    fn faces_group_by_exact_family_in_registration_order() {
        let mut registry = Registry::new();
        let regular = registry.register(stub("Arial", 400, Slant::Upright), None, None);
        let other = registry.register(stub("Calibri", 400, Slant::Upright), None, None);
        let bold = registry.register(stub("Arial", 700, Slant::Upright), None, None);
        assert_eq!(registry.family("Arial"), Some(&[regular, bold][..]));
        assert_eq!(registry.family("Calibri"), Some(&[other][..]));
        assert_eq!(registry.family("arial"), None);
        assert_eq!(registry.default_family(), Some(&[regular, bold][..]));
        let listed = registry.families();
        assert_eq!(listed[0].family, "Arial");
        assert_eq!(listed[0].styles.iter().map(|style| style.weight).collect::<Vec<_>>(), [400, 700]);
    }

    #[test]
    fn an_alias_names_the_family_and_a_same_file_is_not_added_twice() {
        let mut registry = Registry::new();
        let path = Path::new("fonts/a.ttf");
        let first = registry.register(stub("Name Table Family", 400, Slant::Upright), Some("Alias Family"), Some(path));
        let again = registry.register(stub("Name Table Family", 400, Slant::Upright), Some("Alias Family"), Some(path));
        assert_eq!(first, again);
        assert_eq!(registry.len(), 1);
        assert!(registry.family("Alias Family").is_some());
        assert!(registry.family("Name Table Family").is_none());
        registry.set_alias("Alias Family", "Short");
        assert_eq!(registry.family("Short"), registry.family("Alias Family"));
    }

    #[test]
    fn font_files_are_recognised_by_extension() {
        assert!(is_font_file(Path::new("A.TTF")));
        assert!(is_font_file(Path::new("a.ttc")));
        assert!(!is_font_file(Path::new("a.woff2")));
        assert!(!is_font_file(Path::new("fonts")));
    }
}
