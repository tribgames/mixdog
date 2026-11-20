//! The provisioned Noto faces and the Office-for-Mac faces, registered the way `warmupInstalledOfficeFonts` of
//! `runtime/office/portable/font-provisioner.mjs` registers them.
//!
//! The ten Noto faces are downloaded and registered with the OS by the daemon (`prepareOfficeFonts`); this module
//! holds what both sides share (the pinned table, with the size and sha256 each file must have) and does the in-process
//! half: it finds an installed face (the user font folder first, then the system folder), checks its size and sha256
//! against the table, and registers it in the registry under the table's family name. The Office-for-Mac font folder
//! (the faces of Excel, Word, PowerPoint or Outlook, which are never registered with the system) is registered first,
//! the first app bundle found being the one Excel draws with.

use std::path::{Path, PathBuf};

use mixdog_fsio::ReadProof;
use sha2::Digest;
use sha2::Sha256;

use crate::discovery::HostEnv;
use crate::discovery::Os;
use crate::registry::FaceId;
use crate::registry::Registry;

/// google/fonts commit the URLs and digests below were taken from.
const RAW: &str = "https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl";

/// The Office for Mac apps whose bundles carry the shared font folder, in the order Node looks.
const MAC_OFFICE_APPS: [&str; 4] = ["Microsoft Excel", "Microsoft Word", "Microsoft PowerPoint", "Microsoft Outlook"];

/// `NOTO_FONT_DEFINITIONS`.
pub struct FontDef {
    pub id: &'static str,
    pub family: &'static str,
    pub file_name: &'static str,
    pub registry_name: &'static str,
    /// The path under the pinned google/fonts commit.
    pub path: &'static str,
    pub bytes: usize,
    pub sha256: &'static str,
}

macro_rules! font {
    ($id:literal, $family:literal, $file:literal, $dir:literal, $name:literal, $bytes:literal, $sha:literal) => {
        FontDef {
            id: $id,
            family: $family,
            file_name: $file,
            registry_name: concat!($family, " (TrueType)"),
            path: concat!($dir, "/", $name),
            bytes: $bytes,
            sha256: $sha,
        }
    };
}

pub const NOTO_FONTS: [FontDef; 10] = [
    font!(
        "noto-sans-latin",
        "Noto Sans",
        "NotoSans-Variable.ttf",
        "notosans",
        "NotoSans%5Bwdth%2Cwght%5D.ttf",
        2049096,
        "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d"
    ),
    font!(
        "noto-sans-kr",
        "Noto Sans KR",
        "NotoSansKR-Variable.ttf",
        "notosanskr",
        "NotoSansKR%5Bwght%5D.ttf",
        10414588,
        "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252"
    ),
    font!(
        "noto-sans-sc",
        "Noto Sans SC",
        "NotoSansSC-Variable.ttf",
        "notosanssc",
        "NotoSansSC%5Bwght%5D.ttf",
        17772300,
        "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"
    ),
    font!(
        "noto-sans-jp",
        "Noto Sans JP",
        "NotoSansJP-Variable.ttf",
        "notosansjp",
        "NotoSansJP%5Bwght%5D.ttf",
        9589900,
        "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f"
    ),
    font!(
        "noto-sans-tc",
        "Noto Sans TC",
        "NotoSansTC-Variable.ttf",
        "notosanstc",
        "NotoSansTC%5Bwght%5D.ttf",
        11941968,
        "864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f"
    ),
    font!(
        "noto-sans-arabic",
        "Noto Sans Arabic",
        "NotoSansArabic-Variable.ttf",
        "notosansarabic",
        "NotoSansArabic%5Bwdth%2Cwght%5D.ttf",
        844676,
        "63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e"
    ),
    font!(
        "noto-sans-devanagari",
        "Noto Sans Devanagari",
        "NotoSansDevanagari-Variable.ttf",
        "notosansdevanagari",
        "NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf",
        641944,
        "14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e"
    ),
    font!(
        "noto-sans-thai",
        "Noto Sans Thai",
        "NotoSansThai-Variable.ttf",
        "notosansthai",
        "NotoSansThai%5Bwdth%2Cwght%5D.ttf",
        218652,
        "5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8"
    ),
    font!(
        "noto-sans-hebrew",
        "Noto Sans Hebrew",
        "NotoSansHebrew-Variable.ttf",
        "notosanshebrew",
        "NotoSansHebrew%5Bwdth%2Cwght%5D.ttf",
        112640,
        "7ef36a2c3593758cdb622e1bdef4f84523e92fbc3ccc667438dd80ff54c2de88"
    ),
    font!(
        "noto-sans-bengali",
        "Noto Sans Bengali",
        "NotoSansBengali-Variable.ttf",
        "notosansbengali",
        "NotoSansBengali%5Bwdth%2Cwght%5D.ttf",
        463668,
        "dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a"
    ),
];

impl FontDef {
    /// Where the face is downloaded from.
    pub fn url(&self) -> String {
        format!("{RAW}/{}", self.path)
    }
}

/// `verifyFontBuffer`: the size and the sha256 the table pins, with Node's messages.
pub fn verify(def: &FontDef, buffer: &[u8]) -> Result<(), String> {
    if buffer.len() != def.bytes {
        return Err(format!("Font {} size mismatch: expected {} bytes, got {}", def.family, def.bytes, buffer.len()));
    }
    let digest: String = Sha256::digest(buffer).iter().map(|byte| format!("{byte:02x}")).collect();
    if digest != def.sha256 {
        return Err(format!("Font {} sha256 mismatch: expected {}, got {digest}", def.family, def.sha256));
    }
    Ok(())
}

/// `isFontInstalled`: the face's file in the user font folder, else in the system folder.
pub fn installed_path<P: ReadProof>(proof: &P, env: &HostEnv, def: &FontDef) -> Option<PathBuf> {
    [env.user_font_dir(), env.system_font_dir()].into_iter().map(|dir| dir.join(def.file_name)).find(|path| mixdog_fsio::exists(proof, path).unwrap_or(false))
}

/// `macOfficeFontDirectory`: the font folder of the first installed Office for Mac app, on macOS only.
pub fn mac_office_font_dir<P: ReadProof>(proof: &P, env: &HostEnv) -> Option<PathBuf> {
    if env.os != Os::Mac {
        return None;
    }
    MAC_OFFICE_APPS
        .iter()
        .map(|app| PathBuf::from(format!("/Applications/{app}.app/Contents/Resources/DFonts")))
        .find(|dir| mixdog_fsio::exists(proof, dir).unwrap_or(false))
}

/// What became of one provisioned face.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provisioned {
    /// Registered under the table's family name; retained bytes match the verified snapshot.
    Registered(FaceId),
    /// Not installed.
    Absent,
    /// Installed, but not registered: the file could not be read, did not match the pinned size or sha256, or is not a
    /// font. The text says why.
    Rejected(String),
}

// Only the verified provisioning seam checks snapshot collisions. Ordinary registry dedup keeps its
// existing semantics. Check before registration so rejection cannot add part of a collection.
fn register_verified(def: &FontDef, path: &Path, bytes: Vec<u8>, registry: &mut Registry) -> Result<FaceId, String> {
    verify(def, &bytes)?;
    if let Some(ids) = registry.family(def.family) {
        for &id in ids {
            // family() also resolves aliases; register_bytes deduplicates actual registered names only.
            if registry.family_of(id) == def.family
                && registry.path_of(id) == Some(path)
                && registry.face(id).bytes().map(|data| data.as_ref()) != Some(bytes.as_slice())
            {
                return Err(format!("Font {} registration conflicts with a retained snapshot: {}", def.family, path.display()));
            }
        }
    }
    registry.register_bytes(path, bytes, Some(def.family)).map(|ids| ids[0]).map_err(|error| error.to_string())
}

/// `warmupInstalledOfficeFonts`: the Office-for-Mac folder, then every installed Noto face in table order. The
/// outcome of each Noto face is returned for the caller to report.
pub fn register_installed<P: ReadProof>(proof: &P, env: &HostEnv, registry: &mut Registry) -> Vec<(&'static str, Provisioned)> {
    if let Some(dir) = mac_office_font_dir(proof, env) {
        registry.register_dir(proof, &dir);
    }
    NOTO_FONTS
        .iter()
        .map(|def| {
            let Some(path) = installed_path(proof, env, def) else { return (def.id, Provisioned::Absent) };
            let outcome = mixdog_fsio::read(proof, &path)
                .map_err(|error| format!("{}: {error}", path.display()))
                .and_then(|bytes| register_verified(def, &path, bytes, registry));
            (def.id, outcome.map_or_else(Provisioned::Rejected, Provisioned::Registered))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_pins_ten_faces_with_distinct_files() {
        assert_eq!(NOTO_FONTS.len(), 10);
        let mut files: Vec<_> = NOTO_FONTS.iter().map(|def| def.file_name).collect();
        files.sort_unstable();
        files.dedup();
        assert_eq!(files.len(), 10);
        let first = &NOTO_FONTS[0];
        assert_eq!((first.id, first.family, first.registry_name), ("noto-sans-latin", "Noto Sans", "Noto Sans (TrueType)"));
        assert_eq!(
            first.url(),
            "https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf"
        );
        assert!(NOTO_FONTS.iter().all(|def| def.sha256.len() == 64 && def.registry_name.starts_with(def.family)));
    }

    #[test]
    fn a_buffer_is_verified_with_nodes_messages() {
        let hello = FontDef {
            id: "x",
            family: "Hello",
            file_name: "h.ttf",
            registry_name: "",
            path: "",
            bytes: 5,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        };
        assert_eq!(verify(&hello, b"hello"), Ok(()));
        assert_eq!(verify(&hello, b"hell"), Err("Font Hello size mismatch: expected 5 bytes, got 4".to_owned()));
        assert_eq!(
            verify(&hello, b"HELLO"),
            Err("Font Hello sha256 mismatch: expected 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824, got 3733cd977ff8eb18b987357e22ced99f46097f31ecb239e878ae63760e83e4d5".to_owned())
        );
    }

    #[test]
    fn office_for_mac_is_looked_for_on_macos_only() {
        let env = HostEnv { os: Os::Linux, home: PathBuf::from("/home/ann"), windir: None, local_app_data: None, xdg_data_home: None };
        assert_eq!(mac_office_font_dir(&mixdog_fsio::Unlaned, &env), None);
    }

    // A face of the repository read explicitly, pinned by the size and sha256 of its own bytes; no HostEnv or
    // installed-font discovery is involved.
    fn pinned_fixture(bold: bool) -> (FontDef, Vec<u8>) {
        let file_name = if bold { "LiberationSans-Bold.ttf" } else { "LiberationSans-Regular.ttf" };
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts").join(file_name);
        let data = mixdog_fsio::read(&mixdog_fsio::Unlaned, path).unwrap();
        let sha256: &'static str = Box::leak(format!("{:x}", Sha256::digest(&data)).into_boxed_str());
        (FontDef { id: "fixture", family: "Pinned", file_name, registry_name: "", path: "", bytes: data.len(), sha256 }, data)
    }
    #[test]
    fn verified_new_bytes_cannot_certify_an_older_retained_snapshot() {
        let path = Path::new("isolated-not-read/snapshot.ttf");
        let (old_def, old) = pinned_fixture(false);
        let (new_def, new) = pinned_fixture(true);
        verify(&old_def, &old).unwrap();
        verify(&new_def, &new).unwrap();
        let mut registry = Registry::new();
        let id = registry.register_described(path, &old, Some("Pinned")).unwrap();
        let outcome = register_verified(&new_def, path, new, &mut registry).map_or_else(Provisioned::Rejected, Provisioned::Registered);
        assert!(matches!(outcome, Provisioned::Rejected(ref message) if message.contains("retained snapshot")));
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.face(id).bytes().unwrap().as_ref(), old.as_slice());
        assert_eq!(registry.face(id).style.weight, 400);
        assert_eq!(register_verified(&old_def, path, old.clone(), &mut registry), Ok(id));
        assert_eq!(register_verified(&old_def, path, old, &mut registry), Ok(id));
        assert_eq!(registry.len(), 1);
    }
    #[test]
    fn verified_identical_new_registration_is_repeatable() {
        let path = Path::new("isolated-not-read/snapshot.ttf");
        let (def, bytes) = pinned_fixture(true);
        let mut registry = Registry::new();
        let id = register_verified(&def, path, bytes.clone(), &mut registry).unwrap();
        assert_eq!(registry.face(id).bytes().unwrap().as_ref(), bytes.as_slice());
        assert_eq!(register_verified(&def, path, bytes, &mut registry), Ok(id));
        assert_eq!(registry.len(), 1);
    }
}
