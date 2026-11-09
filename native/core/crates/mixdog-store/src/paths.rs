//! The install's two roots as Node's `shared/plugin-paths.mjs` resolves them (`mixdogRoot()`,
//! `resolvePluginData()`): one value, resolved once at boot and handed to every reader.

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// `mixdogRoot()`: the shipped `rules/`, `output-styles/`, `defaults/`, `orchestration/`.
    pub plugin_root: PathBuf,
    /// `resolvePluginData()`.
    pub data_dir: PathBuf,
}

impl Paths {
    /// `package_root` is the install's JS package root (`JsRuntime::package_root`), whose `src`
    /// is Node's `packagedRoot()`; `env` reads a variable, an empty one counting as unset as in
    /// `process.env.X || ..`; `home` is `os.homedir()`. `None` when the data dir falls back to
    /// the home and there is none.
    pub fn resolve(package_root: &Path, env: &dyn Fn(&str) -> Option<OsString>, home: Option<PathBuf>) -> Option<Paths> {
        let set = |name: &str| env(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        let plugin_root = Self::plugin_root_of(package_root, env);
        let data_dir = match set("MIXDOG_DATA_DIR") {
            Some(dir) => dir,
            None => set("MIXDOG_HOME").or_else(|| home.map(|h| h.join(".mixdog")))?.join("data"),
        };
        Some(Paths { plugin_root, data_dir })
    }

    /// `mixdogRoot()` = `MIXDOG_ROOT || packagedRoot()`: the root of the shipped files, which a packaged desktop points at the
    /// unpacked tree (`resources/runtime.asar.unpacked/node_modules/mixdog/src`).
    pub fn plugin_root_of(package_root: &Path, env: &dyn Fn(&str) -> Option<OsString>) -> PathBuf {
        env("MIXDOG_ROOT").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| package_root.join("src"))
    }

    /// [`Paths::resolve`] over the process environment and `std::env::home_dir`, which reads what
    /// `os.homedir()` reads (`USERPROFILE` on Windows, `HOME` elsewhere, then the system record).
    pub fn from_process(package_root: &Path) -> Option<Paths> {
        Self::resolve(package_root, &|name| std::env::var_os(name), std::env::home_dir())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn resolve(vars: &[(&str, &str)], home: Option<&str>) -> Option<Paths> {
        let vars: HashMap<String, OsString> = vars.iter().map(|(k, v)| ((*k).to_owned(), OsString::from(v))).collect();
        Paths::resolve(Path::new("/pkg"), &|name| vars.get(name).cloned(), home.map(PathBuf::from))
    }

    fn paths(plugin_root: &str, data_dir: &str) -> Option<Paths> {
        Some(Paths { plugin_root: plugin_root.into(), data_dir: data_dir.into() })
    }

    /// `mixdogRoot()` = `MIXDOG_ROOT || packagedRoot()`; `resolvePluginData()` =
    /// `MIXDOG_DATA_DIR || join(MIXDOG_HOME || join(homedir(), '.mixdog'), 'data')`.
    #[test]
    fn the_roots_resolve_as_nodes_plugin_paths() {
        let home = Path::new("/home/u");
        let default_data = home.join(".mixdog").join("data");
        assert_eq!(resolve(&[], Some("/home/u")), Some(Paths { plugin_root: Path::new("/pkg").join("src"), data_dir: default_data.clone() }));
        assert_eq!(resolve(&[("MIXDOG_ROOT", "/r"), ("MIXDOG_DATA_DIR", "/d")], None), paths("/r", "/d"));
        assert_eq!(
            resolve(&[("MIXDOG_HOME", "/h")], Some("/home/u")),
            Some(Paths { plugin_root: Path::new("/pkg").join("src"), data_dir: Path::new("/h").join("data") })
        );
        assert_eq!(resolve(&[("MIXDOG_DATA_DIR", "/d"), ("MIXDOG_HOME", "/h")], None).unwrap().data_dir, Path::new("/d"));
        let empty = resolve(&[("MIXDOG_ROOT", ""), ("MIXDOG_DATA_DIR", ""), ("MIXDOG_HOME", "")], Some("/home/u")).unwrap();
        assert_eq!((empty.plugin_root, empty.data_dir), (Path::new("/pkg").join("src"), default_data), "empty counts as unset");
        assert_eq!(resolve(&[], None), None, "no home to fall back to");
    }
}
