//! `shared/asar-path.mjs`: files that external processes (PowerShell, Office) must open by path cannot live inside an
//! Electron ASAR archive; they map to the unpacked sidecar directory.

use std::sync::LazyLock;

use mixdog_js::JsRegex;

static ASAR_SEGMENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"([\\/][^\\/]+\.asar)([\\/])", "i"));

/// `physicalAsarPath(path)`: the first `<name>.asar` directory of the path becomes `<name>.asar.unpacked`.
pub fn physical_asar_path(path: &str) -> String {
    let Some(caps) = ASAR_SEGMENT.captures(path) else { return path.to_owned() };
    let range = caps.range();
    format!(
        "{}{}.unpacked{}{}",
        &path[..range.start],
        caps.get(1).unwrap_or_default(),
        caps.get(2).unwrap_or_default(),
        &path[range.end..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_archive_directory_becomes_its_unpacked_sidecar() {
        assert_eq!(physical_asar_path(r"C:\app\resources\app.asar\native\x.exe"), r"C:\app\resources\app.asar.unpacked\native\x.exe");
        assert_eq!(physical_asar_path("/a/APP.ASAR/b.ps1"), "/a/APP.ASAR.unpacked/b.ps1");
        assert_eq!(physical_asar_path("/a/b/c.ps1"), "/a/b/c.ps1");
        assert_eq!(physical_asar_path("/a/app.asar"), "/a/app.asar");
        assert_eq!(physical_asar_path("/a/x.asar/y.asar/z"), "/a/x.asar.unpacked/y.asar/z");
    }
}
