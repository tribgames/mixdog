//! The scripts the product ships inside its built-in skills, by their path relative to the built-in skills
//! root, with the SHA-256 of each file.
//!
//! A script is recognised by its canonical location under the skills root, or by identical content, so a
//! byte-identical copy of a shipped skill (an installed or exported one) keeps working. The digest is taken
//! over the file with line ends as LF, the form the repository stores, so a checkout that converted them
//! matches too.

use std::path::Path;
use std::path::PathBuf;

use mixdog_fsio::ReadProof;
use mixdog_js::nodepath;
use sha2::Digest;
use sha2::Sha256;

use crate::Outcome;

/// A shipped script this crate runs itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Native {
    ValidateSkill,
    Inventory,
}

/// One shipped script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shipped {
    /// The path relative to the built-in skills root, with `/` separators.
    pub path: &'static str,
    /// The SHA-256 of the file (line ends as LF), in lower-case hex.
    pub sha256: &'static str,
    /// How this crate runs it; `None` for a script that still runs under the extension host until
    /// `nr-exthost-skill-scripts-office` ports it.
    pub native: Option<Native>,
}

pub const SHIPPED: &[Shipped] = &[
    Shipped {
        path: "skill-creator/scripts/validate-skill.mjs",
        sha256: "ee877a2d4f86c627a0a30e6e766a31ac52c32ea152d8214923e32243d203dab7",
        native: Some(Native::ValidateSkill),
    },
    Shipped {
        path: "test-suite/scripts/inventory.mjs",
        sha256: "25eb95e83134506369882c8454fa33e8f2bcefa25304688932d18cb2fe44b737",
        native: Some(Native::Inventory),
    },
    Shipped {
        path: "pptx/scripts/source-extract.mjs",
        sha256: "bf5469676e88730562bee6630a1c618bd0aecd5564218faf693318fe8994c24e",
        native: None,
    },
    Shipped {
        path: "pptx/scripts/qc-pages.mjs",
        sha256: "da3b2c76ffffd6ca26583a47e45ceb7394e42b1c3015249d32baaa60861eea66",
        native: None,
    },
    Shipped {
        path: "pptx/scripts/review-deck.mjs",
        sha256: "2d492cd6dd09593c40c732cf2a37725e668465a0d0be81278280c2fbb259bf11",
        native: None,
    },
];

/// The largest file looked at by content: shipped scripts are a few tens of kilobytes.
const CONTENT_LIMIT: u64 = 1 << 20;

/// The digest [`Shipped::sha256`] holds for these bytes: SHA-256 with `\r\n` read as `\n`.
pub fn script_digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    let mut from = 0;
    for (at, pair) in bytes.windows(2).enumerate() {
        if pair == b"\r\n" {
            hasher.update(&bytes[from..at]);
            from = at + 1;
        }
    }
    hasher.update(&bytes[from..]);
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A path made comparable: canonical when it exists, otherwise resolved against the working directory.
fn canonical<P: ReadProof>(proof: &P, path: &Path) -> PathBuf {
    mixdog_fsio::canonicalize(proof, path).unwrap_or_else(|_| PathBuf::from(nodepath::resolve_host(&[&path.to_string_lossy()])))
}

/// The part of `path` below `root`, with `/` separators, when it lies below it. Windows folds case.
fn below(path: &Path, root: &Path) -> Option<String> {
    let (path, root) = (path.to_string_lossy().replace('\\', "/"), root.to_string_lossy().replace('\\', "/"));
    let root = root.trim_end_matches('/');
    let head = path.get(..root.len())?;
    let same = if cfg!(windows) { head.eq_ignore_ascii_case(root) } else { head == root };
    path[root.len()..].strip_prefix('/').filter(|_| same).map(str::to_owned)
}

/// The shipped script `path` is: the one at its location under `skills_root`, otherwise the one its content is.
pub fn shipped_script<P: ReadProof>(proof: &P, path: &Path, skills_root: &Path) -> Option<Shipped> {
    let location = canonical(proof, path);
    if let Some(rel) = below(&location, &canonical(proof, skills_root)) {
        let found = SHIPPED.iter().find(|shipped| {
            if cfg!(windows) { shipped.path.eq_ignore_ascii_case(&rel) } else { shipped.path == rel }
        });
        if let Some(shipped) = found {
            return Some(*shipped);
        }
    }
    mixdog_fsio::metadata(proof, &location).ok().filter(|meta| meta.is_file() && meta.len() <= CONTENT_LIMIT)?;
    let digest = script_digest(&mixdog_fsio::read(proof, &location).ok()?);
    SHIPPED.iter().find(|shipped| shipped.sha256 == digest).copied()
}

/// Runs a native shipped script with its command-line arguments. `today` is the date `inventory` reports.
pub fn run_native<P: ReadProof>(proof: &P, native: Native, args: &[String], today: &str) -> Outcome {
    match native {
        Native::ValidateSkill => crate::validate_skill::run_validate_skill(proof, args),
        Native::Inventory => crate::inventory::run_inventory(proof, args, today),
    }
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;

    use super::*;

    fn skills_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src/defaults/skills")
    }

    #[test]
    fn the_table_matches_the_scripts_of_this_tree() {
        for shipped in SHIPPED {
            let bytes = mixdog_testkit::read(skills_root().join(shipped.path));
            assert_eq!(script_digest(&bytes), shipped.sha256, "{} changed: update its digest in shipped.rs", shipped.path);
        }
    }

    #[test]
    fn every_script_of_the_built_in_skills_is_in_the_table() {
        let mut on_disk: Vec<String> = Vec::new();
        for skill in mixdog_testkit::entry_names(skills_root()) {
            let scripts = skills_root().join(&skill).join("scripts");
            if !mixdog_testkit::is_dir(&scripts) {
                continue;
            }
            for name in mixdog_testkit::entry_names(&scripts) {
                let name = name.to_string_lossy().into_owned();
                // Tests and libraries of a script are not scripts a skill runs.
                if name.ends_with(".mjs") && !name.ends_with(".test.mjs") {
                    on_disk.push(format!("{}/scripts/{name}", skill.to_string_lossy()));
                }
            }
        }
        let mut table: Vec<&str> = SHIPPED.iter().map(|shipped| shipped.path).collect();
        on_disk.sort();
        table.sort_unstable();
        assert_eq!(on_disk, table);
    }

    #[test]
    fn a_script_is_known_by_its_location_under_the_skills_root() {
        let root = skills_root();
        let shipped = shipped_script(&Unlaned, &root.join("skill-creator/scripts/validate-skill.mjs"), &root).expect("shipped");
        assert_eq!(shipped.native, Some(Native::ValidateSkill));
        let pptx = shipped_script(&Unlaned, &root.join("pptx/scripts/qc-pages.mjs"), &root).expect("shipped");
        assert_eq!(pptx.native, None);
        assert_eq!(shipped_script(&Unlaned, &root.join("skill-creator/SKILL.md"), &root), None);
        assert_eq!(shipped_script(&Unlaned, &root.join("skill-creator/scripts/missing.mjs"), &root), None);
    }

    #[test]
    fn a_byte_identical_copy_elsewhere_is_known_by_its_content() {
        let copy = tempfile::tempdir().expect("temp dir");
        let bytes = mixdog_testkit::read(skills_root().join("test-suite/scripts/inventory.mjs"));
        let target = copy.path().join("renamed.mjs");
        mixdog_testkit::write(&target, &bytes);
        let other_root = copy.path().join("skills");
        mixdog_testkit::create_dir_all(&other_root);
        let found = shipped_script(&Unlaned, &target, &other_root).expect("known by content");
        assert_eq!(found.path, "test-suite/scripts/inventory.mjs");
        let crlf = String::from_utf8(bytes).expect("utf8").replace('\n', "\r\n");
        mixdog_testkit::write(&target, crlf);
        assert_eq!(shipped_script(&Unlaned, &target, &other_root).map(|shipped| shipped.path), Some("test-suite/scripts/inventory.mjs"));
        mixdog_testkit::write(&target, "console.log('not shipped');");
        assert_eq!(shipped_script(&Unlaned, &target, &other_root), None);
    }

    #[test]
    fn the_digest_reads_a_crlf_pair_as_a_line_feed() {
        assert_eq!(script_digest(b"a\r\nb\r\n"), script_digest(b"a\nb\n"));
        assert_ne!(script_digest(b"a\rb"), script_digest(b"a\nb"));
        assert_eq!(script_digest(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
