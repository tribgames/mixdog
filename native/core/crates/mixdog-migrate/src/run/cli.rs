//! `mixdogd migrate`: the argument-driven entry. SPEC/LR define the subcommand only as
//! "convert a 1.4.5 data directory (one-shot)", resumable by running it again; there is
//! no status, dry-run or verify mode (the journal and `complete.json` are the status).

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_store::schema::migration::Complete;

use super::MigrateOptions;
use super::Migrator;
use super::product_drivers;
use crate::error::Blocked;
use crate::framework::MigrationRoots;
use crate::index::IndexProjector;
use crate::session::context_blobs::OfficeExtractor;

/// Arguments of `mixdogd migrate`; every `None` falls back to the environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrateArgs {
    /// `<D>`: `--data-dir`, else `$MIXDOG_DATA_DIR`, else `~/.mixdog/data`.
    pub data_dir: Option<PathBuf>,
    /// `<H>`: `--home`, else `$MIXDOG_HOME`, else `~/.mixdog`.
    pub home: Option<PathBuf>,
    /// `<P>`: the launcher's `--desktop-profile`, else `desktop_profile_dir`'s fallbacks.
    pub desktop_profile: Option<PathBuf>,
}

/// Exit status: the migration reached `complete.json` (now or in an earlier run).
pub const EXIT_COMPLETE: u8 = 0;
/// Exit status: `migration_blocked` (SM §11.5); running again resumes.
pub const EXIT_BLOCKED: u8 = 1;
/// Exit status: no data dir could be resolved (no home in the environment).
pub const EXIT_NO_DATA_DIR: u8 = 2;

/// The roots `args` names under the environment `env`; `None` when neither the
/// arguments nor the environment give a home.
pub fn resolve_roots(args: &MigrateArgs, env: &dyn Fn(&str) -> Option<OsString>) -> Option<MigrationRoots> {
    let set = |name: &str| env(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let user_home = || set("HOME").or_else(|| set("USERPROFILE"));
    let mixdog_home = || user_home().map(|h| h.join(".mixdog"));
    let data = args
        .data_dir
        .clone()
        .or_else(|| set("MIXDOG_DATA_DIR"))
        .or_else(|| mixdog_home().map(|h| h.join("data")))?;
    let home = args.home.clone().or_else(|| set("MIXDOG_HOME")).or_else(mixdog_home)?;
    let profile = crate::desktop_profile::desktop_profile_dir_with(args.desktop_profile.as_deref(), env);
    Some(MigrationRoots { data, home, profile })
}

/// Runs (or resumes) the migration of the roots `args` resolves to.
pub fn migrate(
    roots: MigrationRoots,
    projector: Arc<dyn IndexProjector>,
    office: OfficeExtractor,
) -> Result<Complete, Blocked> {
    Migrator::new(roots, product_drivers(projector, office), MigrateOptions::default()).run()
}

/// The roots of `mixdogd migrate`: `args` over the process environment; when there are none,
/// says why on stderr and gives `EXIT_NO_DATA_DIR`.
pub fn roots(args: &MigrateArgs) -> Result<MigrationRoots, u8> {
    resolve_roots(args, &|name| std::env::var_os(name)).ok_or_else(|| {
        eprintln!("mixdogd migrate: no data dir (set --data-dir, MIXDOG_DATA_DIR or HOME)");
        EXIT_NO_DATA_DIR
    })
}

/// `mixdogd migrate` over [`roots`]: runs the migration, prints `complete.json` on stdout or the
/// blocking error on stderr, and returns the exit status (`EXIT_*`). Call it outside every async
/// context: `office` is driven with its runtime handle from this thread.
pub fn main(roots: MigrationRoots, projector: Arc<dyn IndexProjector>, office: OfficeExtractor) -> u8 {
    match migrate(roots, projector, office) {
        Ok(complete) => {
            println!("{}", serde_json::to_string(&complete).expect("complete encodes"));
            EXIT_COMPLETE
        }
        Err(blocked) => {
            eprintln!("mixdogd migrate: migration_blocked: {blocked}");
            EXIT_BLOCKED
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| OsString::from(v))
    }

    #[test]
    fn arguments_win_over_the_environment() {
        let args = MigrateArgs {
            data_dir: Some("/d".into()),
            home: Some("/h".into()),
            desktop_profile: Some("/p".into()),
        };
        let roots = resolve_roots(&args, &env(&[("MIXDOG_DATA_DIR", "/x"), ("HOME", "/u")])).unwrap();
        assert_eq!(roots.data, Path::new("/d"));
        assert_eq!(roots.home, Path::new("/h"));
        assert!(roots.profile.unwrap().ends_with("p"));
    }

    #[test]
    fn defaults_follow_the_user_home() {
        let vars = [("HOME", "/u")];
        let roots = resolve_roots(&MigrateArgs::default(), &env(&vars)).unwrap();
        assert_eq!(roots.data, Path::new("/u/.mixdog/data"));
        assert_eq!(roots.home, Path::new("/u/.mixdog"));
        assert_eq!(resolve_roots(&MigrateArgs::default(), &env(&[])), None);
    }
}
