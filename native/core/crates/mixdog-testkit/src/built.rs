//! Paths a test build bakes in at compile time, read at run time first: a build reused from a nextest archive runs from
//! another directory than the one it was compiled in. nextest hands each test the moved helper binaries in the variables
//! cargo sets while compiling; it does not do so for the scratch directory.

use std::path::PathBuf;

/// The helper binary `name` of the calling crate: `bin_exe!("mixdog-mcp-mock-server")`.
#[macro_export]
macro_rules! bin_exe {
    ($name:literal) => {
        $crate::runtime_path(concat!("CARGO_BIN_EXE_", $name), env!(concat!("CARGO_BIN_EXE_", $name)))
    };
}

/// The scratch directory of the integration tests: `tmp` in the target directory the running test executable lives in, so it
/// is on the executable's own filesystem (a hard link to a helper binary works) in a plain run and in an extracted archive.
#[macro_export]
macro_rules! target_tmpdir {
    () => {
        $crate::target_tmpdir()
    };
}

/// The value of `var` when the run sets it, else the path the build baked in.
pub fn runtime_path(var: &str, baked: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| baked.to_owned())
}

/// `<target>/tmp`, created with its parents; the executable is `<target>/<profile>/deps/<test>`.
pub fn target_tmpdir() -> PathBuf {
    let exe = std::env::current_exe().expect("the test executable's path");
    let target = exe.ancestors().nth(3).unwrap_or_else(|| panic!("{} is not in a target directory", exe.display()));
    let dir = target.join("tmp");
    std::fs::create_dir_all(&dir).unwrap_or_else(|error| panic!("cannot create {}: {error}", dir.display()));
    dir
}
