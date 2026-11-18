//! `prepareOfficeFonts()` of `runtime/office/portable/font-provisioner.mjs`: the Noto faces the
//! office tools measure with, downloaded once (size and sha256 checked) into the user's font
//! folder and registered with the OS.
//!
//! The provisioner is `mixdog_fonts::install` (the extension-host worker runs the same one after
//! `document.installLibreOffice`); this file is the daemon's host for it: a face is fetched through
//! the daemon's asset fetcher and the registration command runs under its process manager.

use std::collections::HashMap;
use std::sync::Arc;

use mixdog_fonts::install::BoxFuture;
use mixdog_fonts::install::Downloaded;
use mixdog_fonts::install::FontHost;
use mixdog_fonts::install::RegisterCommand;
use mixdog_rt::DurabilityIo;
use mixdog_services::local_provider::assets::Fetcher;
use mixdog_services::tidy::process::Processes;
use mixdog_services::tidy::process::RunOptions;

pub use mixdog_fonts::install::FontDirs;
pub use mixdog_fonts::install::Installed;
pub use mixdog_fonts::provision::FontDef;
pub use mixdog_fonts::provision::NOTO_FONTS;

struct DaemonHost {
    fetcher: Arc<dyn Fetcher>,
    processes: Processes,
}

impl FontHost for DaemonHost {
    fn get(&self, url: &str) -> BoxFuture<'_, Result<Downloaded, String>> {
        let url = url.to_owned();
        Box::pin(async move {
            let mut fetched = self.fetcher.get(&url, 0).await?;
            let status = fetched.status;
            let mut body = Vec::new();
            if (200..300).contains(&status) {
                while let Some(chunk) = fetched.body.next().await? {
                    body.extend_from_slice(&chunk);
                }
            }
            Ok(Downloaded { status, body })
        })
    }

    fn run(&self, command: RegisterCommand) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let mut options = RunOptions::new(&command.cwd);
            options.env = command.env.as_ref();
            options.timeout = command.timeout;
            self.processes.run(&command.program, &command.args, options).await;
        })
    }
}

pub struct OfficeFonts(Arc<mixdog_fonts::install::OfficeFonts>);

impl OfficeFonts {
    pub fn new(fetcher: Arc<dyn Fetcher>, processes: Processes, durability: DurabilityIo, dirs: FontDirs, env: HashMap<String, String>) -> Arc<Self> {
        let host = Arc::new(DaemonHost { fetcher, processes });
        Arc::new(Self(mixdog_fonts::install::OfficeFonts::new(host, durability, dirs, env)))
    }

    /// `verifyFontBuffer`.
    pub fn verify(def: &FontDef, buffer: &[u8]) -> Result<(), String> {
        mixdog_fonts::install::OfficeFonts::verify(def, buffer)
    }

    /// `prepareOfficeFonts()`: every face, three at a time, each failure kept in its own result.
    pub async fn prepare(&self, targets: &[FontDef]) -> Vec<(&'static str, Installed)> {
        self.0.prepare(targets).await
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;
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

    #[cfg(node_twin)]
    #[test]
    fn the_noto_definitions_are_nodes() {
        let golden = crate::domain_seams::golden();
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
    fn a_buffer_is_verified_by_its_size_and_its_sha256() {
        let verify = json!([
            {"name": "ok", "family": "F", "bytes": 15, "sha256": "1d3d0b20551d318c2a005e2711acb90d15c96365e9f3427fb880c022a2fac7dc", "buffer": "good-font-bytes", "error": null},
            {"name": "size", "family": "F", "bytes": 16, "sha256": "1d3d0b20551d318c2a005e2711acb90d15c96365e9f3427fb880c022a2fac7dc", "buffer": "good-font-bytes",
             "error": "Font F size mismatch: expected 16 bytes, got 15"},
            {"name": "sha", "family": "F", "bytes": 15, "sha256": "a5b472f23a1964cd3fe2e888a345383bdf83a4240470e5dfcfc54a3009e08a16", "buffer": "good-font-bytes",
             "error": "Font F sha256 mismatch: expected a5b472f23a1964cd3fe2e888a345383bdf83a4240470e5dfcfc54a3009e08a16, got 1d3d0b20551d318c2a005e2711acb90d15c96365e9f3427fb880c022a2fac7dc"}
        ]);
        for case in verify.as_array().unwrap() {
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

    /// Serves the scripted responses by the last segment of the URL.
    struct Served(Vec<(String, u16, Vec<u8>)>);

    #[async_trait]
    impl Fetcher for Served {
        async fn get(&self, url: &str, _from: i64) -> Result<Fetched, String> {
            let name = url.rsplit('/').next().unwrap_or_default();
            let (_, status, body) = self.0.iter().find(|(served, ..)| served == name).ok_or_else(|| format!("nothing serves {url}"))?;
            Ok(Fetched { status: *status, content_length: None, https: true, body: Box::new(OneChunk(Some(body.clone()))) })
        }
    }


    /// Every face of the `prepareOfficeFonts` scenario that ends without an OS font
    /// registration: a face already installed and the three that fail. The face that downloads
    /// would write the font into the OS registry, so it is not run here.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_faces_that_end_without_a_download_are_present_or_failed() {
        let sha = "1d3d0b20551d318c2a005e2711acb90d15c96365e9f3427fb880c022a2fac7dc";
        let target = |id: &str, file_name: &str, served: &str| json!({"id": id, "family": format!("Family {id}"), "fileName": file_name, "bytes": 15, "sha256": sha, "served": served});
        let prepare = json!({
            "targets": [target("present", "Present.ttf", "/ok.ttf"), target("missing", "missing.ttf", "/missing.ttf"), target("short", "short.ttf", "/short.ttf"), target("wrong", "wrong.ttf", "/wrong.ttf")],
            "served": {
                "/ok.ttf": {"status": 200, "body": "good-font-bytes"},
                "/missing.ttf": {"status": 404, "body": ""},
                "/short.ttf": {"status": 200, "body": "short"},
                "/wrong.ttf": {"status": 200, "body": "wrong-font-byte"}
            },
            "presentFile": "Present.ttf",
            "results": {
                "present": {"installed": true, "skipped": true, "path": "<root>/home/.local/share/fonts/Present.ttf"},
                "missing": {"installed": false, "error": "Failed to download font Family missing (404)"},
                "short": {"installed": false, "error": "Font Family short size mismatch: expected 15 bytes, got 5"},
                "wrong": {"installed": false, "error": format!("Font Family wrong sha256 mismatch: expected {sha}, got 546308d937fccbbb5f99870a26637b30efad79a2a52d2022e95a89325e08634a")}
            }
        });
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
        assert_eq!(portable(&Value::Object(results), dir.path()), prepare["results"]);
    }
}
