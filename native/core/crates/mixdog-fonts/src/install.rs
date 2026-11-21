//! `prepareOfficeFonts()` of `runtime/office/portable/font-provisioner.mjs`: the Noto faces the office tools measure with,
//! downloaded once (size and sha256 checked) into the user's font folder and registered with the OS.
//!
//! One implementation serves the daemon and the extension-host worker. What differs between the two is how a URL is fetched and how a command is run
//! (the daemon fetches through its asset fetcher and spawns through its process manager), so those two steps are the
//! [`FontHost`] the caller hands in; the pinned table, the folders, the checks, the file writes on the durability lane and
//! the registration command are here.
//!
//! Node also registers each face with its canvas library (`GlobalFonts`); a process that wants the faces in its own
//! registry reads them back with [`crate::provision::register_installed`].

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};
use mixdog_statefile::{Opts, create_private_dir_all, metadata, write_file};

use crate::provision::{FontDef, verify};

const BATCH: usize = 3;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const REGISTER_TIMEOUT: Duration = Duration::from_secs(15);

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A GET answered: the status and the whole body.
pub struct Downloaded {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The command that registers a face with the OS.
pub struct RegisterCommand {
    pub program: String,
    pub args: Vec<String>,
    /// The whole environment of the child when set.
    pub env: Option<HashMap<String, String>>,
    pub cwd: PathBuf,
    pub timeout: Duration,
}

/// What the host process contributes: a GET following redirects, and a command run to its end (failures are not reported:
/// a registration that fails is not fatal).
pub trait FontHost: Send + Sync {
    fn get(&self, url: &str) -> BoxFuture<'_, Result<Downloaded, String>>;
    fn run(&self, command: RegisterCommand) -> BoxFuture<'_, ()>;
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
    host: Arc<dyn FontHost>,
    durability: DurabilityIo,
    dirs: FontDirs,
    /// `process.env`, handed to the registration command with the font's name and path added.
    env: HashMap<String, String>,
}

impl OfficeFonts {
    pub fn new(host: Arc<dyn FontHost>, durability: DurabilityIo, dirs: FontDirs, env: HashMap<String, String>) -> Arc<Self> {
        Arc::new(Self { host, durability, dirs, env })
    }

    /// `verifyFontBuffer`.
    pub fn verify(def: &FontDef, buffer: &[u8]) -> Result<(), String> {
        verify(def, buffer)
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
            let fetched = self.host.get(&url).await?;
            if !(200..300).contains(&fetched.status) {
                return Err(format!("Failed to download font {} ({})", def.family, fetched.status));
            }
            Ok(fetched.body)
        };
        mixdog_rt::time::timeout(DOWNLOAD_TIMEOUT, fetch).await.map_err(|_| "The operation was aborted due to timeout".to_owned())?
    }

    /// `registerFontWithOs`: failures are not fatal.
    async fn register(&self, def: &FontDef, target: &Path) {
        let cwd = self.dirs.user.clone();
        if cfg!(windows) {
            let mut env = self.env.clone();
            env.insert("MIXDOG_FONT_NAME".to_owned(), def.registry_name.to_owned());
            env.insert("MIXDOG_FONT_PATH".to_owned(), target.to_string_lossy().into_owned());
            let args = vec![
                "-NoProfile".to_owned(),
                "-Command".to_owned(),
                "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name $env:MIXDOG_FONT_NAME -Value $env:MIXDOG_FONT_PATH -PropertyType String -Force".to_owned(),
            ];
            self.host.run(RegisterCommand { program: "powershell.exe".to_owned(), args, env: Some(env), cwd, timeout: REGISTER_TIMEOUT }).await;
        } else if cfg!(target_os = "linux") {
            let args = vec!["-f".to_owned(), self.dirs.user.to_string_lossy().into_owned()];
            self.host.run(RegisterCommand { program: "fc-cache".to_owned(), args, env: None, cwd, timeout: REGISTER_TIMEOUT }).await;
        }
    }

    async fn install_downloaded(&self, def: &FontDef) -> Result<PathBuf, String> {
        let target = self.dirs.user.join(def.file_name);
        let (dir, path) = (self.dirs.user.clone(), target.clone());
        let buffer = self.download(def).await?;
        verify(def, &buffer)?;
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
