//! The user-data guard and the config layer's use of it against Node's recording (`fixtures/user-data-guard/golden.json`,
//! recorded by `benchmarks/rust-core/recorders/record-user-data-guard.mjs`): every scenario runs the recorded operations
//! over a data dir and must give Node's answers, Node's log lines, and leave Node's full directory tree (names and bytes).
//!
//! What the recording normalizes is Node's own nondeterminism, fixed the same way here: the clock (each operation's `at`),
//! the ids (counting up from 1), and the scenario's root path (`<root>`) with the scope folder name that is a hash of it
//! (`<scope>`). File modes are not compared: the recording was made on Windows, where Node's modes are advisory. An error
//! is compared by its code and message (Node's error class is not a Rust concept).

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;

use super::Config;
use super::ConfigError;
use super::ConfigLanes;
use crate::user_data::Env;
use crate::user_data::UserData;
use crate::user_data::hash16;
use crate::user_data::normalize_data_dir;

fn lanes() -> ConfigLanes {
    let tokens = mixdog_rt::testing::tokens();
    ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io }
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

/// Runs `job` as a job of the write lane.
fn on_write<R: Send + 'static>(job: impl FnOnce(&mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
    block_on(super::on_lane(lanes().write, job)).unwrap()
}

struct World {
    root: PathBuf,
    data: PathBuf,
    scope: String,
    guard: Arc<UserData>,
    now: Arc<AtomicI64>,
    log: Arc<Mutex<Vec<String>>>,
}

impl World {
    fn new(root: &Path, scenario: &Value) -> Self {
        let data = root.join("data");
        let expand_root = root.to_string_lossy().into_owned();
        let mut vars: BTreeMap<String, Option<String>> = BTreeMap::new();
        vars.insert("MIXDOG_HOME".into(), Some(root.join("mhome").to_string_lossy().into_owned()));
        for (name, value) in scenario["env"].as_object().unwrap() {
            vars.insert(name.clone(), value.as_str().map(|text| text.replace("$ROOT", &expand_root)));
        }
        let env = Env::new(move |name| vars.get(name).cloned().flatten(), Some(root.join("home")));
        let now = Arc::new(AtomicI64::new(0));
        let ids = AtomicU64::new(0);
        let log = Arc::new(Mutex::new(Vec::new()));
        let guard = {
            let now = now.clone();
            let log = log.clone();
            Arc::new(UserData::new(
                env,
                move || now.load(Ordering::SeqCst),
                move || format!("00000000-0000-4000-8000-{:012}", ids.fetch_add(1, Ordering::SeqCst) + 1),
                move |line| log.lock().unwrap().push(format!("{line}\n")),
            ))
        };
        let scope = hash16(&normalize_data_dir(&data));
        Self { root: root.to_owned(), data, scope, guard, now, log }
    }

    fn expand(&self, text: &str) -> String {
        let data = self.data.to_string_lossy().into_owned();
        let root = self.root.to_string_lossy().into_owned();
        let escape = |text: &str| serde_json::to_string(text).unwrap().trim_matches('"').to_owned();
        text.replace("$DATA_J", &escape(&data)).replace("$ROOT_J", &escape(&root)).replace("$DATA", &data).replace("$ROOT", &root)
    }

    fn normalize(&self, text: &str) -> String {
        let root = self.root.to_string_lossy().into_owned();
        let escaped = serde_json::to_string(&root).unwrap().trim_matches('"').to_owned();
        text.replace(&escaped, "<root>").replace(&root, "<root>").replace(&root.to_lowercase(), "<root>").replace(&self.scope, "<scope>")
    }

    fn json(&self, value: &Value) -> Value {
        serde_json::from_str(&self.normalize(&value.to_string())).unwrap()
    }

    fn paths(&self, paths: &[PathBuf]) -> Value {
        Value::Array(paths.iter().map(|path| Value::String(path.to_string_lossy().into_owned())).collect())
    }

    fn open(&self) -> Result<Config, ConfigError> {
        let publisher = Arc::new(MockStatePublisher::default());
        block_on(Config::open_guarded(self.data.join("mixdog-config.json"), publisher, lanes(), self.guard.clone())).map(|(config, _)| config)
    }

    fn run(&self, op: &Value) -> Result<Value, (Option<String>, String)> {
        let plain = |error: &dyn std::fmt::Display| (None, error.to_string());
        let guard = &self.guard;
        let data = self.data.clone();
        let fresh = op["fresh"].as_bool().unwrap_or(false);
        match op["op"].as_str().unwrap() {
            "file" => {
                let path = op["path"].as_str().unwrap().replace("$SCOPE", &self.scope);
                let path = self.root.join(path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, self.expand(op["text"].as_str().unwrap())).unwrap();
                Ok(Value::Null)
            }
            "rm" => {
                let path = self.root.join(op["path"].as_str().unwrap());
                if path.is_dir() { std::fs::remove_dir_all(path).unwrap() } else if path.exists() { std::fs::remove_file(path).unwrap() }
                Ok(Value::Null)
            }
            "read" => {
                let config = self.open().map_err(|error| user_data_error(&error))?;
                Ok(Value::Object((*config.full()).clone()))
            }
            "update" => {
                let config = Config::open_unread(self.data.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes(), self.guard.clone());
                let set = op["set"].as_object().unwrap().clone();
                block_on(config.update(move |doc| {
                    for (key, value) in set {
                        doc.insert(key, value);
                    }
                    Ok(())
                }))
                .map_err(|error| user_data_error(&error))?;
                Ok(Value::Object((*config.full()).clone()))
            }
            "backup" => {
                let reason = op["reason"].as_str().unwrap().to_owned();
                let dirs: Vec<String> = op["dirs"].as_array().map(|dirs| dirs.iter().map(|dir| dir.as_str().unwrap().to_owned()).collect()).unwrap_or_default();
                let mut last = Value::Null;
                for _ in 0..op["repeat"].as_u64().unwrap_or(1) {
                    if op["step"].as_bool().unwrap_or(false) {
                        self.now.fetch_add(1000, Ordering::SeqCst);
                    }
                    let (guard, data, reason, dirs) = (guard.clone(), data.clone(), reason.clone(), dirs.clone());
                    let result = on_write(move |lane| {
                        let dirs: Vec<&str> = dirs.iter().map(String::as_str).collect();
                        guard.backup_user_data(lane, &data, &reason, &dirs)
                    })
                    .map_err(|error| plain(&error))?;
                    last = json!({ "dir": result.dir.map(|dir| dir.to_string_lossy().into_owned()), "copied": self.paths(&result.copied) });
                }
                Ok(last)
            }
            "mark" => {
                let guard = guard.clone();
                let marked = on_write(move |lane| guard.mark_initialized(lane, &data)).map_err(|error| plain(&error))?;
                Ok(marked.map_or(Value::Null, Value::String))
            }
            "ensure" => {
                let guard = guard.clone();
                on_write(move |lane| guard.ensure_initialized(lane, &data)).map_err(|error| plain(&error))?;
                Ok(Value::Null)
            }
            "legacy" => {
                let guard = guard.clone();
                let evidence = on_write(move |lane| guard.legacy_evidence(lane, &data, fresh)).map_err(|error| plain(&error))?;
                Ok(evidence.map_or(Value::Null, |e| json!({ "markers": self.paths(&e.markers), "backups": self.paths(&e.backups), "roots": self.paths(&e.roots) })))
            }
            "expected" => {
                let guard = guard.clone();
                on_write(move |lane| guard.is_recovery_expected(lane, &data, fresh)).map(Value::Bool).map_err(|error| plain(&error))
            }
            "loadLatest" => {
                let guard = guard.clone();
                let loaded = on_write(move |lane| guard.load_latest_config(lane, &data, fresh)).map_err(|error| plain(&error))?;
                Ok(loaded.unwrap_or(Value::Null))
            }
            other => panic!("unknown op {other}"),
        }
    }

    /// Every file with its bytes, and every directory (empty ones too), below the root.
    fn tree(&self) -> (BTreeMap<String, Value>, Vec<String>) {
        fn walk(world: &World, dir: &Path, files: &mut BTreeMap<String, Value>, dirs: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    let rel = path.strip_prefix(&world.root).unwrap().to_string_lossy().replace('\\', "/");
                    dirs.push(world.normalize(&rel));
                    walk(world, &path, files, dirs);
                    continue;
                }
                let rel = path.strip_prefix(&world.root).unwrap().to_string_lossy().replace('\\', "/");
                let bytes = std::fs::read(&path).unwrap();
                let value = match String::from_utf8(bytes.clone()) {
                    Ok(text) => json!({ "text": world.normalize(&text) }),
                    Err(_) => json!({ "b64": base64_of(&bytes) }),
                };
                files.insert(world.normalize(&rel), value);
            }
        }
        let mut files = BTreeMap::new();
        let mut dirs = Vec::new();
        walk(self, &self.root, &mut files, &mut dirs);
        dirs.sort();
        (files, dirs)
    }
}

fn base64_of(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0_u32, |n, (i, byte)| n | (u32::from(*byte) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn user_data_error(error: &ConfigError) -> (Option<String>, String) {
    match error {
        ConfigError::UserData { code, message } => (code.map(str::to_owned), message.clone()),
        other => (None, other.to_string()),
    }
}

#[test]
fn every_recorded_scenario_leaves_nodes_answers_logs_and_tree() {
    let golden: Value = serde_json::from_slice(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/user-data-guard/golden.json")).unwrap()).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = std::path::absolute(dir.path()).unwrap().join("run");
        std::fs::create_dir_all(root.join("home")).unwrap();
        let world = World::new(&root, scenario);
        // The recorded scope folder is the hash of the recorded data dir: the hash is Node's own output.
        assert_eq!(hash16(scenario["dataDirKey"].as_str().unwrap()), scenario["scopeName"].as_str().unwrap(), "{name}: scope hash");
        let ops = scenario["ops"].as_array().unwrap();
        let results = scenario["results"].as_array().unwrap();
        assert_eq!(ops.len(), results.len(), "{name}");
        for (op, recorded) in ops.iter().zip(results) {
            let at = op["at"].as_i64().unwrap_or_else(|| world.now.load(Ordering::SeqCst));
            world.now.store(at, Ordering::SeqCst);
            let _clock = mixdog_statefile::fix_recovery_clock(at as u128);
            world.log.lock().unwrap().clear();
            let outcome = world.run(op);
            let label = format!("{name} / {}", op["op"]);
            let stderr: Vec<String> = world.log.lock().unwrap().iter().map(|line| world.normalize(line)).collect();
            assert_eq!(json!(stderr), recorded["stderr"], "{label}: log lines");
            match outcome {
                Ok(answer) => {
                    assert!(recorded["error"].is_null(), "{label}: Node threw {}", recorded["error"]);
                    assert_eq!(world.json(&answer), recorded["answer"], "{label}: answer");
                }
                Err((code, message)) => {
                    let expected = &recorded["error"];
                    assert!(!expected.is_null(), "{label}: Rust threw {message}");
                    assert_eq!(code.map_or(Value::Null, Value::String), expected["code"], "{label}: error code");
                    assert_eq!(Value::String(world.normalize(&message)), expected["message"], "{label}: error message");
                }
            }
        }
        let (tree, dirs) = world.tree();
        let recorded_dirs: Vec<&str> = scenario["dirs"].as_array().unwrap().iter().map(|d| d.as_str().unwrap()).collect();
        assert_eq!(dirs.iter().map(String::as_str).collect::<Vec<_>>(), recorded_dirs, "{name}: directories");
        let recorded: BTreeMap<String, Value> = scenario["files"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        assert_eq!(tree.keys().collect::<Vec<_>>(), recorded.keys().collect::<Vec<_>>(), "{name}: file names");
        for (path, bytes) in &tree {
            assert_eq!(bytes, &recorded[path], "{name}: {path}");
        }
    }
}
