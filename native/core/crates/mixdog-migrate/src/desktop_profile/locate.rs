//! Where the Electron profile `<P>` lives (SPEC §4.11).

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

/// Set by the desktop launcher to the profile it names for the core it starts.
pub const USER_DATA_ENV: &str = "MIXDOG_DESKTOP_USER_DATA";

/// `<P>`: the launcher's `--desktop-profile` when given, else `MIXDOG_DESKTOP_USER_DATA` when set.
/// `None` when the launcher names none: the core never guesses a profile (D-profile-1).
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
    absolute(Path::new(&non_empty(env(USER_DATA_ENV))?))
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
        let env = env_of(&[(USER_DATA_ENV, "ignored")]);
        assert_eq!(desktop_profile_dir_with(Some(&arg), &env), Some(arg));
    }

    #[test]
    fn user_data_variable_names_the_profile() {
        let dir = std::env::temp_dir().join("isolated-run");
        let env = env_of(&[(USER_DATA_ENV, dir.to_str().unwrap())]);
        assert_eq!(desktop_profile_dir_with(None, &env), Some(dir));
    }

    #[test]
    fn empty_user_data_variable_is_unset() {
        let env = env_of(&[(USER_DATA_ENV, "")]);
        assert_eq!(desktop_profile_dir_with(None, &env), None);
    }

    #[test]
    fn the_os_app_data_is_never_a_profile() {
        let env = env_of(&[
            ("APPDATA", "C:/Users/u/AppData/Roaming"),
            ("HOME", "/home/u"),
            ("XDG_CONFIG_HOME", "/xdg"),
        ]);
        assert_eq!(desktop_profile_dir_with(None, &env), None);
    }
}
