// RULE BUNDLES, the build script's part both builds of the library share: this package's own (`build.rs`) and the
// Rust core's (`native/core/crates/mixdog-graph/build.rs`, whose manifest lives elsewhere and so names this package's
// directory itself).
//
// `rules/outline/*.yml` holds the outline extractor rules for the languages
// ast-grep's `DEFAULT_OUTLINE_RULES` does not cover, and `rules/calls/*.yml`
// holds the call-site rules for every extraction language. Every file in
// those directories is concatenated into one multi-document YAML stream at
// `$OUT_DIR/outline_rules.yml` / `$OUT_DIR/call_rules.yml`, which
// `src/outline.rs` and `src/calls.rs` pull in with `include_str!`. Rule
// authors therefore only ever ADD a file; no Rust file lists them. A missing
// or empty directory is normal (the generated stream is then empty) and must
// not fail the build.
use std::path::Path;
use std::path::PathBuf;

fn bundle_rules(package_dir: &Path, kind: &str, out_file: &str, count_env: &str) {
    let rules_dir = package_dir.join("rules").join(kind);
    // Re-run when a rule file is added, removed, or edited. Watching the
    // directory covers add/remove; each file is watched for edits below.
    println!("cargo:rerun-if-changed={}", rules_dir.display());

    let mut sources: Vec<PathBuf> = match std::fs::read_dir(&rules_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_file()
                    && path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| {
                            ext.eq_ignore_ascii_case("yml") || ext.eq_ignore_ascii_case("yaml")
                        })
            })
            .collect(),
        // No directory yet (or unreadable): bundle nothing.
        Err(_) => Vec::new(),
    };
    // Deterministic order so the generated stream — and therefore rule
    // precedence within the bundle — never depends on directory iteration.
    sources.sort();

    let mut bundle = String::new();
    for path in &sources {
        println!("cargo:rerun-if-changed={}", path.display());
        let Ok(text) = std::fs::read_to_string(path) else {
            println!(
                "cargo:warning=mixdog-graph {kind} rules skipped (unreadable): {}",
                path.display()
            );
            continue;
        };
        // A UTF-8 BOM would end up inside the first YAML key.
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text).trim();
        if text.is_empty() {
            continue;
        }
        if !bundle.is_empty() {
            bundle.push_str("\n---\n");
        }
        // `# file:` markers keep rule-parse diagnostics traceable back to the
        // authoring file even though everything lands in one stream.
        bundle.push_str("# file: ");
        bundle.push_str(&path.file_name().unwrap_or_default().to_string_lossy());
        bundle.push('\n');
        bundle.push_str(text);
        bundle.push('\n');
    }

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let out_path = out_dir.join(out_file);
    // An unchanged rewrite would still bump the mtime that rustc's dep-info compares.
    if std::fs::read_to_string(&out_path).ok().as_deref() != Some(bundle.as_str()) {
        std::fs::write(&out_path, bundle).unwrap_or_else(|error| {
            panic!("failed to write {}: {error}", out_path.display());
        });
    }
    // Also expose the source count so a build log can show the bundle size.
    println!("cargo:rustc-env={count_env}={}", sources.len());
}

/// Bundles the rules of the package in `package_dir` (the directory of `native/mixdog-graph`).
pub fn bundle_outline_rules(package_dir: &Path) {
    bundle_rules(package_dir, "outline", "outline_rules.yml", "MIXDOG_OUTLINE_RULE_FILES");
    bundle_rules(package_dir, "calls", "call_rules.yml", "MIXDOG_CALL_RULE_FILES");
}
