// Inventory cache keys and the ordered request overrides that shape a
// walk. The key carries every rule that can change the file set, so two
// requests share an inventory only when their enumeration is identical.
use super::*;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct WalkKey {
    pub(super) operand: PathBuf,
    pub(super) hidden: bool,
    pub(super) no_ignore: bool,
    pub(super) no_require_git: bool,
    pub(super) max_depth: Option<usize>,
    pub(super) directories: bool,
    // Overrides affect both pruning and ignore precedence. Preserve their
    // order in the inventory key, including positive and insensitive globs.
    pub(super) prune: Vec<String>,
    pub(super) iglobs: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct FuzzyKey {
    pub(super) walk: WalkKey,
    pub(super) globs: Vec<String>,
    pub(super) iglobs: Vec<String>,
}

/// Apply ordered request overrides during enumeration, before ignore rules.
/// Keep directory exclusions exactly as requested so later positive rules
/// can re-include children. The internal .git exclusion remains in force
/// unless the operand explicitly targets that directory.
pub(super) fn prune_globs(operand: &Path, parsed: &ParsedArgs) -> Vec<String> {
    let mut prune = parsed.globs.clone();
    if !path_has_segment(operand, ".git") {
        prune.push("!**/.git".to_string());
        prune.push("!**/.git/**".to_string());
    }
    prune
}

pub(super) fn prune_overrides(
    operand: &Path,
    prune: &[String],
    iglobs: &[String],
) -> Option<Override> {
    if prune.is_empty() && iglobs.is_empty() {
        return None;
    }
    let root = if operand.is_file() {
        operand.parent().unwrap_or(operand)
    } else {
        operand
    };
    let mut builder = OverrideBuilder::new(root);
    for glob in prune {
        // A malformed exclusion must never abort the walk; the post-walk
        // PathFilter still rejects the same paths.
        if builder.add(glob).is_err() {
            return None;
        }
    }
    builder.case_insensitive(true).ok()?;
    for glob in iglobs {
        builder.add(glob).ok()?;
    }
    builder.build().ok()
}

pub(super) fn walk_key(operand: &Path, parsed: &ParsedArgs) -> WalkKey {
    WalkKey {
        operand: normalized_operand(operand),
        hidden: parsed.hidden,
        no_ignore: parsed.no_ignore,
        no_require_git: parsed.no_require_git,
        max_depth: parsed.max_depth,
        directories: parsed.directories,
        prune: prune_globs(operand, parsed),
        iglobs: parsed.iglobs.clone(),
    }
}

pub(super) fn fuzzy_key(operand: &Path, parsed: &ParsedArgs) -> FuzzyKey {
    let globs = parsed.globs.clone();
    let iglobs = parsed.iglobs.clone();
    FuzzyKey {
        walk: walk_key(operand, parsed),
        globs,
        iglobs,
    }
}
