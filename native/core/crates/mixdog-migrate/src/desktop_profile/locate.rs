//! Where the Electron profile `<P>` lives (SPEC §4.11).

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

/// Isolates a desktop run to its own profile.
pub const USER_DATA_ENV: &str = "MIXDOG_DESKTOP_USER_DATA";
/// The folder under Electron's `appData` (`electron-builder.yml` `name`).
pub const PROFILE_DIR_NAME: &str = "mixdog-desktop";

/// `<P>`: the launcher's `--desktop-profile` when given, else `MIXDOG_DESKTOP_USER_DATA`
/// when set, else `<appData>/mixdog-desktop`. `None` only when the OS gives no `appData`.
pub fn desktop_profile_dir(launcher_arg: Option<&Path>) -> Option<PathBuf> {
    desktop_profile_dir_with(launcher_arg, &|name| std::env::var_os(name))
}

/// `desktop_profile_dir` over an explicit environment.
pub fn desktop_profile_dir_with(
    launcher_arg: Option<&Path>,
    env: &dyn Fn(&str) -> Option<OsString>,
) -> Option<PathBuf> {
    if let Some(path) = launcher_arg {
        return absolute(path);
    }
    if let Some(path) = non_empty(env(USER_DATA_ENV)) {
        return absolute(Path::new(&path));
    }
    Some(app_data(env)?.join(PROFILE_DIR_NAME))
}

/// Electron's `appData`.
fn app_data(env: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if cfg!(windows) {
        return non_empty(env("APPDATA")).map(PathBuf::from);
    }
    if cfg!(target_os = "macos") {
        let home = non_empty(env("HOME"))?;
        return Some(PathBuf::from(home).join("Library/Application Support"));
    }
    if let Some(config) = non_empty(env("XDG_CONFIG_HOME")) {
        return Some(PathBuf::from(config));
    }
    Some(PathBuf::from(non_empty(env("HOME"))?).join(".config"))
}

fn non_empty(value: Option<OsString>) -> Option<OsString> {
    value.filter(|value| !value.is_empty())
}

fn absolute(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }
    std::path::absolute(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> + use<> {
        let pairs: Vec<(String, OsString)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), OsString::from(value)))
            .collect();
        move |name| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    }

    #[test]
    fn launcher_argument_wins_over_environment() {
        let arg = std::env::temp_dir().join("launcher-profile");
        let env = env_of(&[(USER_DATA_ENV, "ignored"), ("APPDATA", "ignored")]);
        assert_eq!(desktop_profile_dir_with(Some(&arg), &env), Some(arg));
    }

    #[test]
    fn user_data_variable_wins_over_app_data() {
        let dir = std::env::temp_dir().join("isolated-run");
        let env = env_of(&[(USER_DATA_ENV, dir.to_str().unwrap()), ("APPDATA", "ignored")]);
        assert_eq!(desktop_profile_dir_with(None, &env), Some(dir));
    }

    #[test]
    fn empty_user_data_variable_is_unset() {
        let env = env_of(&[
            (USER_DATA_ENV, ""),
            ("APPDATA", "C:/AppData"),
            ("HOME", "/home/u"),
            ("XDG_CONFIG_HOME", "/xdg"),
        ]);
        let found = desktop_profile_dir_with(None, &env).unwrap();
        assert!(found.ends_with(PROFILE_DIR_NAME));
    }

    #[test]
    fn app_data_follows_the_platform() {
        let env = env_of(&[
            ("APPDATA", "C:/Users/u/AppData/Roaming"),
            ("HOME", "/home/u"),
            ("XDG_CONFIG_HOME", "/xdg"),
        ]);
        let found = desktop_profile_dir_with(None, &env).unwrap();
        let expected = if cfg!(windows) {
            PathBuf::from("C:/Users/u/AppData/Roaming")
        } else if cfg!(target_os = "macos") {
            PathBuf::from("/home/u/Library/Application Support")
        } else {
            PathBuf::from("/xdg")
        };
        assert_eq!(found, expected.join(PROFILE_DIR_NAME));
    }

    #[test]
    fn no_app_data_means_no_profile() {
        assert_eq!(desktop_profile_dir_with(None, &env_of(&[])), None);
    }
}
