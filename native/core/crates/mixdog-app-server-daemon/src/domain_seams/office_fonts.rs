//! `prepareOfficeFonts()` of `runtime/office/portable/font-provisioner.mjs`: the Noto faces the
//! office tools measure with, downloaded once (size and sha256 checked) into the user's font
//! folder and registered with the OS.
//!
//! Node also registers each face with its canvas library (`GlobalFonts`); the core has no
//! in-process font registry, so that step does not exist here.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use mixdog_services::local_provider::assets::Fetcher;
use mixdog_services::tidy::process::Processes;
use mixdog_services::tidy::process::RunOptions;
use mixdog_statefile::Opts;
use mixdog_statefile::create_private_dir_all;
use mixdog_statefile::metadata;
use mixdog_statefile::write_file;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

/// google/fonts commit the URLs and digests below were taken from.
const RAW: &str = "https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl";
const BATCH: usize = 3;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const REGISTER_TIMEOUT: Duration = Duration::from_secs(15);

/// `NOTO_FONT_DEFINITIONS`.
pub struct FontDef {
    pub id: &'static str,
    pub family: &'static str,
    pub file_name: &'static str,
    pub registry_name: &'static str,
    path: &'static str,
    pub bytes: usize,
    pub sha256: &'static str,
}

macro_rules! font {
    ($id:literal, $family:literal, $file:literal, $dir:literal, $name:literal, $bytes:literal, $sha:literal) => {
        FontDef {
            id: $id,
            family: $family,
            file_name: $file,
            registry_name: concat!($family, " (TrueType)"),
            path: concat!($dir, "/", $name),
            bytes: $bytes,
            sha256: $sha,
        }
    };
}

pub const NOTO_FONTS: [FontDef; 10] = [
    font!("noto-sans-latin", "Noto Sans", "NotoSans-Variable.ttf", "notosans", "NotoSans%5Bwdth%2Cwght%5D.ttf", 2049096, "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d"),
    font!("noto-sans-kr", "Noto Sans KR", "NotoSansKR-Variable.ttf", "notosanskr", "NotoSansKR%5Bwght%5D.ttf", 10414588, "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252"),
    font!("noto-sans-sc", "Noto Sans SC", "NotoSansSC-Variable.ttf", "notosanssc", "NotoSansSC%5Bwght%5D.ttf", 17772300, "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da"),
    font!("noto-sans-jp", "Noto Sans JP", "NotoSansJP-Variable.ttf", "notosansjp", "NotoSansJP%5Bwght%5D.ttf", 9589900, "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f"),
    font!("noto-sans-tc", "Noto Sans TC", "NotoSansTC-Variable.ttf", "notosanstc", "NotoSansTC%5Bwght%5D.ttf", 11941968, "864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f"),
    font!("noto-sans-arabic", "Noto Sans Arabic", "NotoSansArabic-Variable.ttf", "notosansarabic", "NotoSansArabic%5Bwdth%2Cwght%5D.ttf", 844676, "63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e"),
    font!("noto-sans-devanagari", "Noto Sans Devanagari", "NotoSansDevanagari-Variable.ttf", "notosansdevanagari", "NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf", 641944, "14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e"),
    font!("noto-sans-thai", "Noto Sans Thai", "NotoSansThai-Variable.ttf", "notosansthai", "NotoSansThai%5Bwdth%2Cwght%5D.ttf", 218652, "5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8"),
    font!("noto-sans-hebrew", "Noto Sans Hebrew", "NotoSansHebrew-Variable.ttf", "notosanshebrew", "NotoSansHebrew%5Bwdth%2Cwght%5D.ttf", 112640, "7ef36a2c3593758cdb622e1bdef4f84523e92fbc3ccc667438dd80ff54c2de88"),
    font!("noto-sans-bengali", "Noto Sans Bengali", "NotoSansBengali-Variable.ttf", "notosansbengali", "NotoSansBengali%5Bwdth%2Cwght%5D.ttf", 463668, "dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a"),
];

impl FontDef {
    pub fn url(&self) -> String {
        format!("{RAW}/{}", self.path)
    }
}

/// `getUserFontDirectory()` and `systemFontDirectory()` for this host.
pub struct FontDirs {
    pub user: PathBuf,
    pub system: PathBuf,
}

impl FontDirs {
    /// `env` is `process.env`; `home` is `os.homedir()`.
    pub fn for_host(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        let non_empty = |name: &str| env(name).filter(|value| !value.is_empty());
        if cfg!(windows) {
            let local = non_empty("LOCALAPPDATA").map_or_else(|| home.join("AppData").join("Local"), PathBuf::from);
            let windir = non_empty("WINDIR").unwrap_or_else(|| "C:\\Windows".to_owned());
            Self { user: local.join("Microsoft").join("Windows").join("Fonts"), system: PathBuf::from(windir).join("Fonts") }
        } else if cfg!(target_os = "macos") {
            Self { user: home.join("Library").join("Fonts"), system: PathBuf::from("/Library/Fonts") }
        } else {
            Self { user: home.join(".local").join("share").join("fonts"), system: PathBuf::from("/usr/share/fonts") }
        }
    }
}

/// The outcome of one face (`{installed, skipped, path}` or `{installed: false, error}`).
#[derive(Debug, PartialEq, Eq)]
pub enum Installed {
    Present(PathBuf),
    Downloaded(PathBuf),
    Failed(String),
}

pub struct OfficeFonts {
    fetcher: Arc<dyn Fetcher>,
    processes: Processes,
    durability: DurabilityIo,
    dirs: FontDirs,
    /// `process.env`, handed to the registration command with the font's name and path added.
    env: HashMap<String, String>,
}

impl OfficeFonts {
    pub fn new(fetcher: Arc<dyn Fetcher>, processes: Processes, durability: DurabilityIo, dirs: FontDirs, env: HashMap<String, String>) -> Arc<Self> {
        Arc::new(Self { fetcher, processes, durability, dirs, env })
    }

    /// `isFontInstalled`: the user folder first, then the system folder.
    async fn find(&self, def: &FontDef) -> Result<Option<PathBuf>, String> {
        let candidates = [self.dirs.user.join(def.file_name), self.dirs.system.join(def.file_name)];
        let job = self
            .durability
            .submit(&CancellationToken::new(), move |lane| candidates.into_iter().find(|path| metadata(lane, path).is_ok()))
            .map_err(|_| "the durability lane is full".to_owned())?;
        job.await.map_err(|error| error.to_string())
    }

    async fn download(&self, def: &FontDef) -> Result<Vec<u8>, String> {
        let url = def.url();
        let fetch = async {
            let mut fetched = self.fetcher.get(&url, 0).await?;
            if !(200..300).contains(&fetched.status) {
                return Err(format!("Failed to download font {} ({})", def.family, fetched.status));
            }
            let mut buffer = Vec::new();
            while let Some(chunk) = fetched.body.next().await? {
                buffer.extend_from_slice(&chunk);
            }
            Ok(buffer)
        };
        mixdog_rt::time::timeout(DOWNLOAD_TIMEOUT, fetch).await.map_err(|_| "The operation was aborted due to timeout".to_owned())?
    }

    /// `verifyFontBuffer`.
    pub fn verify(def: &FontDef, buffer: &[u8]) -> Result<(), String> {
        if buffer.len() != def.bytes {
            return Err(format!("Font {} size mismatch: expected {} bytes, got {}", def.family, def.bytes, buffer.len()));
        }
        let digest: String = Sha256::digest(buffer).iter().map(|byte| format!("{byte:02x}")).collect();
        if digest != def.sha256 {
            return Err(format!("Font {} sha256 mismatch: expected {}, got {digest}", def.family, def.sha256));
        }
        Ok(())
    }

    /// `registerFontWithOs`: failures are not fatal.
    async fn register(&self, def: &FontDef, target: &Path) {
        let cwd = &self.dirs.user;
        if cfg!(windows) {
            let mut env = self.env.clone();
            env.insert("MIXDOG_FONT_NAME".to_owned(), def.registry_name.to_owned());
            env.insert("MIXDOG_FONT_PATH".to_owned(), target.to_string_lossy().into_owned());
            let args = [
                "-NoProfile".to_owned(),
                "-Command".to_owned(),
                "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name $env:MIXDOG_FONT_NAME -Value $env:MIXDOG_FONT_PATH -PropertyType String -Force".to_owned(),
            ];
            let mut options = RunOptions::new(cwd);
            options.env = Some(&env);
            options.timeout = REGISTER_TIMEOUT;
            self.processes.run("powershell.exe", &args, options).await;
        } else if cfg!(target_os = "linux") {
            let args = ["-f".to_owned(), self.dirs.user.to_string_lossy().into_owned()];
            let mut options = RunOptions::new(cwd);
            options.timeout = REGISTER_TIMEOUT;
            self.processes.run("fc-cache", &args, options).await;
        }
    }

    async fn install_downloaded(&self, def: &FontDef) -> Result<PathBuf, String> {
        let target = self.dirs.user.join(def.file_name);
        let (dir, path) = (self.dirs.user.clone(), target.clone());
        let buffer = self.download(def).await?;
        Self::verify(def, &buffer)?;
        let job = self
            .durability
            .submit(&CancellationToken::new(), move |lane| {
                create_private_dir_all(lane, &dir).map_err(|error| error.to_string())?;
                write_file(lane, &path, &buffer, &Opts { mode: 0o644, ..Opts::default() }).map(drop).map_err(|error| error.to_string())
            })
            .map_err(|_| "the durability lane is full".to_owned())?;
        job.await.map_err(|error| error.to_string())??;
        self.register(def, &target).await;
        Ok(target)
    }

    /// `installFont`.
    pub async fn install(&self, def: &FontDef) -> Installed {
        match self.find(def).await {
            Ok(Some(path)) => return Installed::Present(path),
            Ok(None) => {}
            Err(error) => return Installed::Failed(error),
        }
        match self.install_downloaded(def).await {
            Ok(path) => Installed::Downloaded(path),
            Err(error) => Installed::Failed(error),
        }
    }

    /// `prepareOfficeFonts()`: every face, three at a time, each failure kept in its own result.
    pub async fn prepare(&self, targets: &[FontDef]) -> Vec<(&'static str, Installed)> {
        let mut results = Vec::with_capacity(targets.len());
        for batch in targets.chunks(BATCH) {
            let done = futures::future::join_all(batch.iter().map(|def| async move { (def.id, self.install(def).await) })).await;
            results.extend(done);
        }
        results
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;
    use crate::domain_seams::golden;
    use crate::domain_seams::portable;
    use async_trait::async_trait;
    use mixdog_services::local_provider::assets::Body;
    use mixdog_services::local_provider::assets::Fetched;
    use serde_json::Value;
    use serde_json::json;

    /// A definition with the text leaked: tests only.
    fn def(id: &str, family: &str, file_name: &str, path: &str, bytes: usize, sha256: &str) -> FontDef {
        let leak = |text: &str| -> &'static str { Box::leak(text.to_owned().into_boxed_str()) };
        FontDef { id: leak(id), family: leak(family), file_name: leak(file_name), registry_name: "", path: leak(path), bytes, sha256: leak(sha256) }
    }

    #[test]
    fn the_noto_definitions_are_nodes() {
        let golden = golden();
        let nodes = golden["fonts"]["definitions"].as_array().unwrap();
        assert_eq!(NOTO_FONTS.len(), nodes.len());
        for (ours, node) in NOTO_FONTS.iter().zip(nodes) {
            assert_eq!(ours.id, node["id"].as_str().unwrap());
            assert_eq!(ours.family, node["family"].as_str().unwrap());
            assert_eq!(ours.file_name, node["fileName"].as_str().unwrap());
            assert_eq!(ours.registry_name, node["registryName"].as_str().unwrap());
            assert_eq!(ours.url(), node["url"].as_str().unwrap());
            assert_eq!(ours.bytes as u64, node["bytes"].as_u64().unwrap());
            assert_eq!(ours.sha256, node["sha256"].as_str().unwrap());
        }
    }

    #[test]
    fn a_buffer_is_verified_with_nodes_messages() {
        for case in golden()["fonts"]["verify"].as_array().unwrap() {
            let font = def("id", case["family"].as_str().unwrap(), "f.ttf", "f", case["bytes"].as_u64().unwrap() as usize, case["sha256"].as_str().unwrap());
            let verdict = OfficeFonts::verify(&font, case["buffer"].as_str().unwrap().as_bytes());
            match case["error"].as_str() {
                Some(error) => assert_eq!(verdict, Err(error.to_owned()), "{}", case["name"]),
                None => assert_eq!(verdict, Ok(()), "{}", case["name"]),
            }
        }
    }

    struct OneChunk(Option<Vec<u8>>);

    #[async_trait]
    impl Body for OneChunk {
        async fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.take())
        }
    }

    /// Serves the recorded responses by the last segment of the URL.
    struct Served(Vec<(String, u16, Vec<u8>)>);

    #[async_trait]
    impl Fetcher for Served {
        async fn get(&self, url: &str, _from: i64) -> Result<Fetched, String> {
            let name = url.rsplit('/').next().unwrap_or_default();
            let (_, status, body) = self.0.iter().find(|(served, ..)| served == name).ok_or_else(|| format!("nothing serves {url}"))?;
            Ok(Fetched { status: *status, content_length: None, https: true, body: Box::new(OneChunk(Some(body.clone()))) })
        }
    }

    /// Every face of Node's `prepareOfficeFonts` scenario that ends without an OS font
    /// registration: a face already installed and the three that fail. The face that downloads
    /// (`fresh`) would write the font into the OS registry, so it is not run here.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_faces_that_end_without_a_download_match_nodes() {
        let golden = golden();
        let prepare = &golden["fonts"]["prepare"];
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("home").join(".local").join("share").join("fonts");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join(prepare["presentFile"].as_str().unwrap()), "already here").unwrap();
        let served = prepare["served"].as_object().unwrap();
        let fetcher = Served(
            served
                .iter()
                .map(|(path, v)| (path.trim_start_matches('/').to_owned(), v["status"].as_u64().unwrap() as u16, v["body"].as_str().unwrap().as_bytes().to_vec()))
                .collect(),
        );
        let tokens = mixdog_rt::testing::tokens();
        let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        let dirs = FontDirs { user: user.clone(), system: dir.path().join("system-fonts") };
        let fonts = OfficeFonts::new(Arc::new(fetcher), Processes::new(manager, tokens.durability_io), tokens.durability_io, dirs, HashMap::new());
        let targets: Vec<FontDef> = prepare["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["id"] != "fresh")
            .map(|t| def(t["id"].as_str().unwrap(), t["family"].as_str().unwrap(), t["fileName"].as_str().unwrap(), t["served"].as_str().unwrap().trim_start_matches('/'), t["bytes"].as_u64().unwrap() as usize, t["sha256"].as_str().unwrap()))
            .collect();
        let mut results = serde_json::Map::new();
        for (id, installed) in fonts.prepare(&targets).await {
            let shown = match installed {
                Installed::Present(path) => json!({ "installed": true, "skipped": true, "path": path.to_string_lossy() }),
                Installed::Downloaded(path) => json!({ "installed": true, "skipped": false, "path": path.to_string_lossy() }),
                Installed::Failed(error) => json!({ "installed": false, "error": error }),
            };
            results.insert(id.to_owned(), shown);
        }
        let mut expected = prepare["results"].as_object().unwrap().clone();
        expected.retain(|id, _| id != "fresh");
        assert_eq!(portable(&Value::Object(results), dir.path()), Value::Object(expected));
    }
}
