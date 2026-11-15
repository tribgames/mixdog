//! The skill scripts the product ships (`validate-skill.mjs`, `inventory.mjs`) and the launcher's
//! argument carrier, run without a Node runtime.
//!
//! - [`argv`]: the `MIXDOG_SKILL_ARGV` carrier and the entry contract of `skill-script-entry.mjs`.
//! - [`parse_args`]: the part of `node:util` `parseArgs` the shipped scripts use, with Node's error text.
//! - [`validate_skill`]: `skill-creator/scripts/validate-skill.mjs`.
//! - [`inventory`]: `test-suite/scripts/inventory.mjs`.
//! - [`shipped`]: which script a path names, by location under the built-in skills root or by content.
//! - [`run`]: [`skill_run`], the program `mixdog-skill-node` starts (`mixdogd skill-run`): the replacement of
//!   `skill-script-entry.mjs`.
//! - [`user`]: [`UserScriptRuntime`], what runs a script that is not shipped.

pub mod argv;
pub mod inventory;
pub mod mixdogd_exec;
pub mod parse_args;
pub mod qc_pages;
pub mod review_deck;
pub mod run;
pub mod shipped;
pub mod source_extract;
pub mod user;
pub mod validate_skill;

pub use run::skill_run;
pub use user::UserScriptRuntime;

/// What a script run leaves behind: the text it printed on each stream and its exit code.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

impl Outcome {
    /// A finished run that printed `line` (and a line end) on stdout.
    pub(crate) fn print(&mut self, line: &str) {
        self.stdout.push_str(line);
        self.stdout.push('\n');
    }

    /// `console.error(line)`.
    pub(crate) fn eprint(&mut self, line: &str) {
        self.stderr.push_str(line);
        self.stderr.push('\n');
    }
}

/// The text Node gives a failed system call: `<CODE>: <description>, <syscall> '<path>'`.
pub(crate) fn node_fs_message(error: &std::io::Error, syscall: &str, path: &str) -> String {
    const DESCRIPTIONS: &[(&str, &str)] = &[
        ("EPERM", "operation not permitted"),
        ("ENOENT", "no such file or directory"),
        ("EIO", "i/o error"),
        ("EACCES", "permission denied"),
        ("EBUSY", "resource busy or locked"),
        ("ENOTDIR", "not a directory"),
        ("EISDIR", "illegal operation on a directory"),
        ("EINVAL", "invalid argument"),
        ("EMFILE", "too many open files"),
        ("ELOOP", "too many symbolic links encountered"),
        ("ENAMETOOLONG", "name too long"),
    ];
    match mixdog_js::uv_error::error_code(error) {
        Some(code) => {
            let description = DESCRIPTIONS.iter().find(|(name, _)| *name == code).map_or("unknown error", |(_, text)| *text);
            format!("{code}: {description}, {syscall} '{path}'")
        }
        None => error.to_string(),
    }
}
