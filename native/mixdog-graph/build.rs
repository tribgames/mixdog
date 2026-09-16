// Build script: rule bundling (all platforms) + the Windows VERSIONINFO
// resource.
//
// RULE BUNDLES
// ------------
// `rules/outline/*.yml` holds the outline extractor rules for the languages
// ast-grep's `DEFAULT_OUTLINE_RULES` does not cover, and `rules/calls/*.yml`
// holds the call-site rules for every extraction language. Every file in
// those directories is concatenated into one multi-document YAML stream at
// `$OUT_DIR/outline_rules.yml` / `$OUT_DIR/call_rules.yml`, which
// `src/outline.rs` and `src/calls.rs` pull in with `include_str!`. Rule
// authors therefore only ever ADD a file; no Rust file lists them. A missing
// or empty directory is normal (the generated stream is then empty) and must
// not fail the build.
use std::path::PathBuf;

fn bundle_rules(kind: &str, out_file: &str, count_env: &str) {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let rules_dir = manifest_dir.join("rules").join(kind);
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
    std::fs::write(&out_path, bundle).unwrap_or_else(|error| {
        panic!("failed to write {}: {error}", out_path.display());
    });
    // Also expose the source count so a build log can show the bundle size.
    println!("cargo:rustc-env={count_env}={}", sources.len());
}

fn bundle_outline_rules() {
    bundle_rules("outline", "outline_rules.yml", "MIXDOG_OUTLINE_RULE_FILES");
    bundle_rules("calls", "call_rules.yml", "MIXDOG_CALL_RULE_FILES");
}

// Windows VERSIONINFO for the helper executable.
//
// A Rust binary ships NO version resource at all, so this helper was nameless
// in Explorer's properties dialog and in every process list. Stamping the same
// ProductName the desktop app uses (electron-builder.yml `productName: Mixdog`)
// gives it a branded identity wherever Windows reads file metadata.
//
// What this does NOT do is merge the process into the app's Task Manager row.
// That grouping keys off AppUserModelID, which a version resource cannot carry
// — an earlier version of this comment assumed ProductName plus the
// parent/child chain was enough, and the helper kept listing itself at the top
// level. main.rs claims the desktop AUMID at startup to actually fix it.
#[cfg(windows)]
fn main() {
    bundle_outline_rules();
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("ProductName", "Mixdog")
        .set("CompanyName", "Mixdog")
        .set("FileDescription", "Mixdog")
        .set("OriginalFilename", "mixdog-graph.exe")
        .set("LegalCopyright", "Copyright (C) Mixdog")
        .set_icon("../../apps/desktop/build/mixdog.ico");
    // Resource metadata is cosmetic: a machine without the Windows SDK
    // resource compiler must still produce a working binary, so a failure
    // downgrades to the previous "no version info" behaviour instead of
    // breaking the build.
    if let Err(error) = resource.compile() {
        println!("cargo:warning=mixdog-graph version resource skipped: {error}");
    }
}

#[cfg(not(windows))]
fn main() {
    bundle_outline_rules();
}
