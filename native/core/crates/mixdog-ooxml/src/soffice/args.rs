//! What the LibreOffice driver says to the program and about it: the command line of one headless conversion, the registry text
//! that turns every macro off in the private profile, the font configuration headless LibreOffice reads on macOS, the places an
//! installation is looked for, and the name a conversion gives its output.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use mixdog_fonts::discovery::Os;
use mixdog_js::JsRegex;

use crate::xml::xml_encode;

/// The desktop must stay out of the way on every run: without these a first start opens the setup wizard and a previously
/// killed run opens the recovery dialog, and a headless process then waits for a window nobody can answer.
pub const QUIET_ARGS: [&str; 7] =
    ["--headless", "--invisible", "--nocrashreport", "--nodefault", "--nologo", "--nofirststartwizard", "--norestore"];

/// Documents reach this LibreOffice from untrusted sources (chat attachments), so the private profile it runs with turns every
/// macro off: the strictest security level, and macro execution disabled outright.
pub const MACRO_LOCKDOWN_REGISTRY: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<oor:items xmlns:oor=\"http://openoffice.org/2001/registry\" xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n\
<item oor:path=\"/org.openoffice.Office.Common/Security/Scripting\"><prop oor:name=\"MacroSecurityLevel\" oor:op=\"fuse\"><value>3</value></prop></item>\n\
<item oor:path=\"/org.openoffice.Office.Common/Security/Scripting\"><prop oor:name=\"DisableMacrosExecution\" oor:op=\"fuse\"><value>true</value></prop></item>\n\
</oor:items>\n";

/// The facts about the machine the driver reads: the system, the home and temporary folders and the environment variables.
#[derive(Debug, Clone)]
pub struct Host {
    pub os: Os,
    pub home: PathBuf,
    pub temp_dir: PathBuf,
    env: BTreeMap<String, String>,
}

/// `pathToFileURL(path).href`: the profile is named to LibreOffice by URL.
pub fn file_url(path: &Path) -> String {
    reqwest::Url::from_file_path(path).map_or_else(|()| format!("file://{}", path.display()), Into::into)
}

/// `sofficeConvertArguments(profile, { to, outDir, input })`: the command line of one headless conversion, in a private profile.
pub fn convert_arguments(profile: &Path, to: &str, out_dir: &Path, input: &Path) -> Vec<String> {
    let mut args = vec![format!("-env:UserInstallation={}", file_url(profile))];
    args.extend(QUIET_ARGS.iter().map(|flag| (*flag).to_owned()));
    args.extend(["--convert-to".to_owned(), to.to_owned(), "--outdir".to_owned(), out_dir.display().to_string(), input.display().to_string()]);
    args
}

/// What LibreOffice names what it writes: the source's own name minus its extension, then the new one (`report.v2.docx`
/// converted to pdf lands in the out directory as `report.v2.pdf`). Every caller finds its output by that rule.
pub fn converted_output_path(out_dir: &Path, input: &Path, extension: &str) -> PathBuf {
    let stem = input.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    out_dir.join(format!("{stem}.{extension}"))
}

/// `path.win32.join(...)` of folders that need no normalising beyond a single separator between the parts.
fn windows_join(parts: &[&str]) -> String {
    let mut joined = String::new();
    for part in parts {
        if !joined.is_empty() && !joined.ends_with(['\\', '/']) {
            joined.push('\\');
        }
        joined.push_str(if joined.is_empty() { part } else { part.trim_start_matches(['\\', '/']) });
    }
    joined
}

/// Where each system's LibreOffice installers put the program, in the order they are asked. macOS and the Linux snap and
/// Flatpak packages leave it off PATH.
pub fn candidates(host: &Host) -> Vec<String> {
    let home = |parts: &[&str]| parts.iter().fold(host.home.clone(), |path, part| path.join(part)).display().to_string();
    match host.os {
        Os::Windows => {
            let files = host.variable("ProgramFiles").unwrap_or("C:\\Program Files");
            let files_x86 = host.variable("ProgramFiles(x86)").unwrap_or("C:\\Program Files (x86)");
            // soffice.com is the console front-end: it reports through stdio and exits once the conversion finishes. soffice.exe
            // returns early or never, so a caller awaiting its exit cannot tell when output is ready.
            let mut found = vec!["soffice.com".to_owned()];
            let mut known = vec![
                windows_join(&[files, "LibreOffice", "program", "soffice.com"]),
                windows_join(&[files_x86, "LibreOffice", "program", "soffice.com"]),
                "C:\\Program Files\\LibreOffice\\program\\soffice.com".to_owned(),
                "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com".to_owned(),
            ];
            // A per-user install (the MSI's "just for me" choice).
            if let Some(local) = host.variable("LOCALAPPDATA") {
                known.push(windows_join(&[local, "Programs", "LibreOffice", "program", "soffice.com"]));
            }
            for candidate in known {
                if !found.contains(&candidate) {
                    found.push(candidate);
                }
            }
            found
        }
        Os::Mac => vec![
            "soffice".to_owned(),
            "/Applications/LibreOffice.app/Contents/MacOS/soffice".to_owned(),
            home(&["Applications", "LibreOffice.app", "Contents", "MacOS", "soffice"]),
            "/opt/homebrew/bin/soffice".to_owned(),
            "/usr/local/bin/soffice".to_owned(),
        ],
        Os::Linux => vec![
            "soffice".to_owned(),
            "libreoffice".to_owned(),
            "/usr/lib/libreoffice/program/soffice".to_owned(),
            "/snap/bin/libreoffice".to_owned(),
            "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice".to_owned(),
            home(&[".local", "share", "flatpak", "exports", "bin", "org.libreoffice.LibreOffice"]),
        ],
    }
}

/// The LibreOffice installer records its `program` folder as the default value of SOFTWARE\LibreOffice\UNO\InstallPath, in HKLM
/// (all users, 64- or 32-bit view) or HKCU (per-user). This covers installs on another drive or in a custom folder.
pub const REGISTRY_QUERIES: [(&str, &str); 3] = [("HKLM", "/reg:64"), ("HKLM", "/reg:32"), ("HKCU", "/reg:64")];

static REGISTRY_VALUE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"REG_(?:EXPAND_)?SZ\s+(.+?)\s*$", ""));

/// `registrySofficePrograms(output)`: the `soffice.com` paths named by `reg query ... /ve` output. The value's display name is
/// localized, so only the REG_SZ data is read.
pub fn registry_soffice_programs(output: &str) -> Vec<String> {
    output
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter_map(|line| REGISTRY_VALUE.captures(line).and_then(|found| found.get(1).map(str::to_owned)))
        .filter(|directory| !directory.is_empty())
        .map(|directory| windows_join(&[&directory, "soffice.com"]))
        .collect()
}

/// `macFontConfig(cacheDir, officeFontDir)`: headless LibreOffice on macOS finds fonts through its bundled fontconfig, which
/// names none of the Mac's font folders: every face but the few it ships was missing, and a Hangul, CJK, or Thai run rendered as
/// nothing at all. The config names the system, local, and user folders, and the Office for Mac bundle where Excel keeps Calibri
/// and Malgun Gothic, so the preview draws a workbook in Excel's faces.
pub fn mac_font_config(home: &Path, cache_dir: &Path, office_font_dir: Option<&Path>) -> String {
    let mut directories =
        vec!["/System/Library/Fonts".to_owned(), "/Library/Fonts".to_owned(), home.join("Library").join("Fonts").display().to_string()];
    if let Some(office) = office_font_dir.filter(|dir| !dir.as_os_str().is_empty()) {
        directories.push(office.display().to_string());
    }
    let mut lines = vec!["<?xml version=\"1.0\"?>".to_owned(), "<!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">".to_owned(), "<fontconfig>".to_owned()];
    lines.extend(directories.iter().map(|directory| format!("  <dir>{}</dir>", xml_encode(directory))));
    lines.push(format!("  <cachedir>{}</cachedir>", xml_encode(&cache_dir.display().to_string())));
    lines.push("</fontconfig>".to_owned());
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_text_is_the_one_node_writes() {
        let lines: Vec<&str> = MACRO_LOCKDOWN_REGISTRY.split('\n').collect();
        assert_eq!(lines.len(), 6);
        assert_eq!(lines[0], "<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        assert_eq!(lines[4], "</oor:items>");
        assert_eq!(lines[5], "");
        assert!(MACRO_LOCKDOWN_REGISTRY.contains("oor:name=\"MacroSecurityLevel\" oor:op=\"fuse\"><value>3</value>"));
        assert!(MACRO_LOCKDOWN_REGISTRY.contains("oor:name=\"DisableMacrosExecution\" oor:op=\"fuse\"><value>true</value>"));
        assert!(MACRO_LOCKDOWN_REGISTRY.contains("Office.Common/Security/Scripting"));
    }

    #[test]
    fn reg_query_output_names_the_soffice_com_of_the_recorded_install_folder_in_any_ui_language() {
        let english =
            "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\LibreOffice\\UNO\\InstallPath\r\n    (Default)    REG_SZ    D:\\Apps\\LibreOffice 24\\program\r\n\r\n";
        let korean = "HKEY_CURRENT_USER\\SOFTWARE\\LibreOffice\\UNO\\InstallPath\r\n    (기본값)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\LibreOffice\\program\r\n";
        assert_eq!(registry_soffice_programs(english), ["D:\\Apps\\LibreOffice 24\\program\\soffice.com"]);
        assert_eq!(registry_soffice_programs(korean), ["C:\\Users\\me\\AppData\\Local\\Programs\\LibreOffice\\program\\soffice.com"]);
        assert!(registry_soffice_programs("").is_empty());
        assert!(registry_soffice_programs("ERROR: The system was unable to find the specified registry key or value.").is_empty());
    }

    #[test]
    fn the_headless_font_config_names_every_mac_font_folder_and_the_office_bundle_excel_draws_with() {
        let home = Path::new("/Users/me");
        let office = Path::new("/Applications/Microsoft Excel.app/Contents/Resources/DFonts");
        let config = mac_font_config(home, Path::new("/tmp/cache & more"), Some(office));
        let user_fonts = home.join("Library").join("Fonts").display().to_string();
        for directory in ["/System/Library/Fonts", "/Library/Fonts", user_fonts.as_str(), "/Applications/Microsoft Excel.app/Contents/Resources/DFonts"] {
            assert!(config.contains(&format!("<dir>{directory}</dir>")), "{directory}");
        }
        assert!(config.contains("<cachedir>/tmp/cache &amp; more</cachedir>"));
        assert!(!mac_font_config(home, Path::new("/tmp/cache"), None).contains("DFonts"));
        assert!(!mac_font_config(home, Path::new("/tmp/cache"), Some(Path::new(""))).contains("DFonts"));
    }

    #[test]
    fn each_system_looks_where_its_installers_put_the_program() {
        let windows = Host::new(Os::Windows, "C:\\Users\\me", "C:\\Temp", &[("ProgramFiles", "D:\\Apps"), ("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local")]);
        let found = candidates(&windows);
        assert_eq!(found[0], "soffice.com");
        assert_eq!(found[1], "D:\\Apps\\LibreOffice\\program\\soffice.com");
        assert_eq!(found[2], "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com");
        assert_eq!(found[3], "C:\\Program Files\\LibreOffice\\program\\soffice.com");
        assert_eq!(found.last().map(String::as_str), Some("C:\\Users\\me\\AppData\\Local\\Programs\\LibreOffice\\program\\soffice.com"));
        // The default folders named twice are asked once.
        let plain = candidates(&Host::new(Os::Windows, "C:\\Users\\me", "C:\\Temp", &[]));
        assert_eq!(plain.len(), 3);
        let mac = candidates(&Host::new(Os::Mac, "/Users/me", "/tmp", &[]));
        assert_eq!(mac[0], "soffice");
        assert_eq!(mac[1], "/Applications/LibreOffice.app/Contents/MacOS/soffice");
        assert_eq!(Path::new(&mac[2]), Path::new("/Users/me").join("Applications").join("LibreOffice.app").join("Contents").join("MacOS").join("soffice"));
        assert_eq!(mac[3..], ["/opt/homebrew/bin/soffice", "/usr/local/bin/soffice"]);
        let linux = candidates(&Host::new(Os::Linux, "/home/me", "/tmp", &[]));
        assert_eq!(linux[..5], ["soffice", "libreoffice", "/usr/lib/libreoffice/program/soffice", "/snap/bin/libreoffice", "/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice"]);
        assert!(linux[5].contains("org.libreoffice.LibreOffice") && linux[5].starts_with("/home/me"));
    }

    #[test]
    fn output_is_named_after_the_source_without_its_own_extension() {
        assert_eq!(converted_output_path(Path::new("out"), Path::new("dir/report.v2.docx"), "pdf"), Path::new("out").join("report.v2.pdf"));
        assert_eq!(converted_output_path(Path::new("out"), Path::new("t.csv"), "xlsx"), Path::new("out").join("t.xlsx"));
    }


    #[test]
    fn conversions_launch_in_a_private_profile_with_first_start_and_recovery_prompts_off() {
        let profile = std::env::temp_dir().join("profile-x");
        let args = convert_arguments(&profile, "xlsx", Path::new("out"), Path::new("in.xls"));
        assert!(args[0].starts_with("-env:UserInstallation=file:///"), "{}", args[0]);
        assert!(args[0].ends_with("/profile-x") && !args[0].contains('\\'), "{}", args[0]);
        for flag in ["--headless", "--norestore", "--nofirststartwizard", "--nologo", "--invisible"] {
            assert!(args.iter().any(|arg| arg == flag), "{flag}");
        }
        assert_eq!(args[args.len() - 5..], ["--convert-to", "xlsx", "--outdir", "out", "in.xls"]);
    }
}


impl Host {
    /// This process: its system, its environment, `os.homedir()` and `os.tmpdir()`.
    pub fn process() -> Self {
        let env: BTreeMap<String, String> = std::env::vars().collect();
        let os = Os::current();
        let home_variable = if os == Os::Windows { "USERPROFILE" } else { "HOME" };
        let home = env.get(home_variable).filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_default();
        Self { os, home, temp_dir: std::env::temp_dir(), env }
    }

    /// A host of the given system with the given variables.
    pub fn new(os: Os, home: impl Into<PathBuf>, temp_dir: impl Into<PathBuf>, env: &[(&str, &str)]) -> Self {
        Self {
            os,
            home: home.into(),
            temp_dir: temp_dir.into(),
            env: env.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(),
        }
    }

    /// `process.env[name]`, an empty variable counting as unset (`process.env.X || fallback`).
    pub fn variable(&self, name: &str) -> Option<&str> {
        self.env.get(name).map(String::as_str).filter(|value| !value.is_empty())
    }
}
