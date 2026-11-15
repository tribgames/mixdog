//! No PowerShell host path is left in the crate: nothing of the product starts `powershell.exe` or `pwsh`, names a script of
//! the retired hosts, or passes `-ExecutionPolicy`; the retired `assets` and `recorder` directories are gone and no `.ps1` file
//! is shipped in `src`. Comments that name the history, and the names of tests that describe how PowerShell converts a value
//! (the value semantics the Rust host reproduces, `src/ps`), are not hits: the scan reads code only, for the words that
//! start or name a PowerShell program.

use std::path::Path;
use std::path::PathBuf;

const FORBIDDEN: [&str; 5] = [".ps1", "executionpolicy", "powershell.exe", "pwsh", "windowspowershell"];

fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in mixdog_fsio::read_dir(&mixdog_fsio::Unlaned, dir).expect("a directory").flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs" || extension == "ps1") {
            found.push(path);
        }
    }
}

/// The code of a line: a whole-line comment is nothing, a trailing comment is cut off.
fn code_of(line: &str) -> &str {
    let trimmed = line.trim_start();
    if trimmed.starts_with("//") {
        return "";
    }
    match line.find(" //") {
        Some(at) => &line[..at],
        None => line,
    }
}

#[test]
fn the_retired_directories_are_gone() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for retired in ["assets", "recorder"] {
        assert!(!root.join(retired).exists(), "{retired} is retired");
    }
    assert!(!root.join("src").join("scripts.rs").exists());
    assert!(!root.join("src").join("route.rs").exists());
}

#[test]
fn no_source_file_of_the_product_starts_or_names_a_powershell_program() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(!files.is_empty());
    let mut hits = Vec::new();
    for file in files {
        assert!(file.extension().is_some_and(|extension| extension == "rs"), "a script in src: {}", file.display());
        let text = mixdog_testkit::read_string(&file);
        for (number, line) in text.lines().enumerate() {
            let code = code_of(line).to_ascii_lowercase();
            if let Some(word) = FORBIDDEN.iter().find(|word| code.contains(**word)) {
                hits.push(format!("{}:{}: {word}", file.display(), number + 1));
            }
        }
    }
    assert!(hits.is_empty(), "{}", hits.join("\n"));
}

#[test]
fn the_manifest_names_no_script_or_recorder() {
    let manifest = mixdog_testkit::read_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"));
    // This test's own entry names itself.
    let kept: Vec<&str> = manifest.lines().filter(|line| !line.trim_start().starts_with('#') && !line.contains("no_powershell")).collect();
    let code = kept.join("
").to_ascii_lowercase();
    for word in [".ps1", "recorder", "powershell"] {
        assert!(!code.contains(word), "Cargo.toml names {word}");
    }
}
