//! The private LibreOffice profile and the scratch folders a conversion works in.
//!
//! Conversion must never attach to the user's own running LibreOffice: a shared profile makes the second invocation either fail
//! or block until the desktop window closes. It must not build a throwaway profile per call either: creating the profile costs
//! far more than the conversion it serves. One private profile is built on first use and reused for the life of the process.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use mixdog_fsio::{DirBuilder, WriteProof};
use mixdog_js::uv_error::error_code;

use super::args::{MACRO_LOCKDOWN_REGISTRY, file_url};
use crate::package::os_message;

/// How long a folder a process still holds is retried before it is reported.
const REMOVE_RETRY: Duration = Duration::from_millis(100);
const REMOVE_ATTEMPTS: u32 = 6;
const RETRYABLE_REMOVE_CODES: [&str; 4] = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"];

/// Why the profile could not be built: the message with the private folder taken out of it, and the system error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileError {
    pub message: String,
    pub code: Option<String>,
}

impl std::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// A step of building the profile, named to a hook that stands in for the file system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The `user` folder inside the new profile.
    UserFolder,
    /// The registry text that locks the macros down.
    Registry,
}

/// `redactDirectories(text, directories)`: `text` with every mention of the given folders taken out (and the separator after it),
/// whether written as a native path, with forward slashes or as a file URL, so an error never discloses a private scratch location.
pub fn redact_directories(text: &str, directories: &[&Path]) -> String {
    let mut out = text.to_owned();
    for directory in directories.iter().filter(|directory| !directory.as_os_str().is_empty()) {
        let native = directory.display().to_string();
        let mut forms = vec![native.clone(), native.replace('\\', "/"), file_url(directory)];
        forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
        forms.dedup();
        for form in forms {
            out = out.replace(&format!("{form}\\"), "").replace(&format!("{form}/"), "").replace(&form, "");
        }
    }
    out
}

fn io_failure(error: &io::Error, syscall: &str, path: &Path, hidden: &Path) -> ProfileError {
    ProfileError { message: redact_directories(&os_message(error, syscall, path), &[hidden]), code: error_code(error).map(str::to_owned) }
}

#[cfg(unix)]
fn private_builder() -> DirBuilder {
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    builder
}

#[cfg(not(unix))]
fn private_builder() -> DirBuilder {
    DirBuilder::new()
}

/// `fs.mkdtemp(prefix)`: a new folder named `{prefix}` and six random characters, owner-only where the system has modes.
pub(crate) fn make_temp_dir<P: WriteProof>(proof: &P, parent: &Path, prefix: &str) -> io::Result<PathBuf> {
    let mut failure = None;
    for _ in 0..64 {
        let suffix: String = uuid::Uuid::new_v4().simple().to_string().chars().take(6).collect();
        let path = parent.join(format!("{prefix}{suffix}"));
        match private_builder().create(proof, &path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => failure = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(failure.unwrap_or_else(|| io::Error::other("no free folder name")))
}

/// `rm(path, { recursive: true, force: true })`: a folder that is already gone is removed.
fn remove_all<P: WriteProof>(proof: &P, path: &Path) -> io::Result<()> {
    match mixdog_fsio::remove_dir_all(proof, path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Removes a folder and says nothing of a failure: for the folder of a run that failed, which the next run replaces.
pub(crate) fn remove_quietly<P: WriteProof>(proof: &P, path: &Path) {
    drop(remove_all(proof, path));
}

/// `removeDirectoryWithRetry(dir, { remove, log })`: removes a private scratch folder. A process that just exited can still hold
/// its files for a moment on Windows, so a busy folder is retried briefly; a failure that persists is logged (never swallowed)
/// and does not fail the caller.
pub fn remove_directory_with_retry<P: WriteProof>(proof: &P, dir: &Path, remove: &dyn Fn(&Path) -> io::Result<()>, log: &dyn Fn(&str), retry: Duration) {
    let mut attempt = 1;
    loop {
        let error = match remove(dir) {
            Ok(()) => return,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(error) => error,
        };
        let retryable = error_code(&error).is_some_and(|code| RETRYABLE_REMOVE_CODES.contains(&code));
        if attempt >= REMOVE_ATTEMPTS || !retryable {
            let message = match error_code(&error) {
                Some(_) => os_message(&error, "rmdir", dir),
                None => error.to_string(),
            };
            log(&format!("scratch folder {} could not be removed: {message}\n", dir.display()));
            return;
        }
        mixdog_fsio::sleep(proof, retry * attempt);
        attempt += 1;
    }
}

/// [`remove_directory_with_retry`] as the driver calls it: the real removal, the standard retry pause, and the standard error stream.
pub fn remove_scratch<P: WriteProof>(proof: &P, dir: &Path) {
    remove_directory_with_retry(
        proof,
        dir,
        &|path| remove_all(proof, path),
        &|line| {
            use std::io::Write;
            drop(io::stderr().write_all(line.as_bytes()));
        },
        REMOVE_RETRY,
    );
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One build of the profile, shared by every caller that asks while it runs.
struct Attempt {
    outcome: Mutex<Option<Result<PathBuf, ProfileError>>>,
    done: Condvar,
}

impl Attempt {
    fn finish(&self, outcome: Result<PathBuf, ProfileError>) {
        *lock(&self.outcome) = Some(outcome);
        self.done.notify_all();
    }

    fn wait(&self) -> Result<PathBuf, ProfileError> {
        let mut outcome = lock(&self.outcome);
        loop {
            match outcome.as_ref() {
                Some(finished) => return finished.clone(),
                None => outcome = self.done.wait(outcome).unwrap_or_else(PoisonError::into_inner),
            }
        }
    }
}

/// The private profile of one driver: built on first use, reused, dropped when a run failed, removed when the driver goes.
pub struct Profiles {
    temp_dir: PathBuf,
    current: Mutex<Option<Arc<Attempt>>>,
    created: Mutex<Vec<PathBuf>>,
}

impl Profiles {
    pub fn new(temp_dir: PathBuf) -> Self {
        Self { temp_dir, current: Mutex::new(None), created: Mutex::new(Vec::new()) }
    }

    /// `sharedProfileDir()`: the profile folder, built if there is none. Callers that ask while it is being built share that
    /// build, and a failed build is not kept: the next call starts over.
    pub fn shared_dir<P: WriteProof>(&self, proof: &P) -> Result<PathBuf, ProfileError> {
        self.shared_dir_with(proof, &|_, _| Ok(()))
    }

    /// [`shared_dir`](Self::shared_dir) with `before` called ahead of each step of the build; an error it answers is the step's.
    pub(crate) fn shared_dir_with<P: WriteProof>(&self, proof: &P, before: &dyn Fn(Step, &Path) -> io::Result<()>) -> Result<PathBuf, ProfileError> {
        let (attempt, builds) = {
            let mut current = lock(&self.current);
            match current.as_ref() {
                Some(attempt) => (Arc::clone(attempt), false),
                None => {
                    let attempt = Arc::new(Attempt { outcome: Mutex::new(None), done: Condvar::new() });
                    *current = Some(Arc::clone(&attempt));
                    (attempt, true)
                }
            }
        };
        if !builds {
            return attempt.wait();
        }
        let outcome = self.build(proof, before);
        if outcome.is_err() {
            let mut current = lock(&self.current);
            if current.as_ref().is_some_and(|held| Arc::ptr_eq(held, &attempt)) {
                *current = None;
            }
        }
        attempt.finish(outcome.clone());
        outcome
    }

    fn build<P: WriteProof>(&self, proof: &P, before: &dyn Fn(Step, &Path) -> io::Result<()>) -> Result<PathBuf, ProfileError> {
        let created = make_temp_dir(proof, &self.temp_dir, "mixdog-office-profile-").map_err(|error| ProfileError {
            message: os_message(&error, "mkdtemp", &self.temp_dir.join("mixdog-office-profile-")),
            code: error_code(&error).map(str::to_owned),
        })?;
        let user = created.join("user");
        let registry = user.join("registrymodifications.xcu");
        let built = before(Step::UserFolder, &user)
            .and_then(|()| mixdog_fsio::create_dir_all(proof, &user))
            .map_err(|error| io_failure(&error, "mkdir", &user, &created))
            .and_then(|()| {
                before(Step::Registry, &registry)
                    .and_then(|()| mixdog_fsio::write(proof, &registry, MACRO_LOCKDOWN_REGISTRY))
                    .map_err(|error| io_failure(&error, "open", &registry, &created))
            });
        if let Err(failure) = built {
            // A half-built profile is never registered, so nothing else would remove it.
            remove_quietly(proof, &created);
            return Err(failure);
        }
        lock(&self.created).push(created.clone());
        Ok(created)
    }

    /// A run that failed or was killed can leave a document lock or a half-written registry behind, and a reused profile would hand
    /// that to every conversion after it. The profile is dropped instead, so the next one builds a clean copy.
    pub fn discard<P: WriteProof>(&self, proof: &P) {
        let Some(attempt) = lock(&self.current).take() else { return };
        if let Ok(directory) = attempt.wait() {
            remove_quietly(proof, &directory);
            lock(&self.created).retain(|known| *known != directory);
        }
    }

    /// Removes every profile this driver built that is still on disk (the folder of a process that has just exited can be held
    /// for a moment, so a busy one is retried).
    pub fn remove_all<P: WriteProof>(&self, proof: &P) {
        lock(&self.current).take();
        let directories = std::mem::take(&mut *lock(&self.created));
        for directory in directories {
            remove_scratch(proof, &directory);
        }
    }

    #[cfg(test)]
    fn building(&self) -> bool {
        lock(&self.current).is_some()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods, reason = "fixtures are read and written directly")]

    use std::sync::atomic::{AtomicUsize, Ordering};

    use mixdog_fsio::Unlaned;

    use super::*;

    /// A disk-full failure of the platform's own spelling.
    fn disk_full() -> io::Error {
        io::Error::from_raw_os_error(if cfg!(windows) { 112 } else { 28 })
    }

    fn failing_at(step: Step) -> impl Fn(Step, &Path) -> io::Result<()> {
        let failures = AtomicUsize::new(1);
        move |at, _| {
            if at == step && failures.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| left.checked_sub(1)).is_ok() { Err(disk_full()) } else { Ok(()) }
        }
    }

    fn folders_of(parent: &Path) -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = std::fs::read_dir(parent).expect("temp folder").map(|entry| entry.expect("entry").path()).collect();
        found.sort();
        found
    }

    #[test]
    fn a_failed_profile_step_cleans_up_hides_the_path_keeps_the_code_and_the_next_call_retries() {
        for step in [Step::UserFolder, Step::Registry] {
            let temp = tempfile::tempdir().expect("temp folder");
            let profiles = Profiles::new(temp.path().to_path_buf());
            let failing = failing_at(step);
            let error = profiles.shared_dir_with(&Unlaned, &failing).expect_err("the first build fails");
            assert!(!error.message.contains(temp.path().to_str().expect("utf-8")), "{}", error.message);
            assert!(error.message.contains("ENOSPC"), "{}", error.message);
            assert_eq!(error.code.as_deref(), Some("ENOSPC"));
            assert!(folders_of(temp.path()).is_empty(), "the half-built profile is removed");
            let profile = profiles.shared_dir_with(&Unlaned, &failing).expect("the next call builds again");
            assert_eq!(folders_of(temp.path()), [profile.clone()]);
            assert_eq!(std::fs::read_to_string(profile.join("user").join("registrymodifications.xcu")).expect("registry"), MACRO_LOCKDOWN_REGISTRY);
            assert_eq!(profiles.shared_dir(&Unlaned).expect("shared"), profile);
        }
    }

    #[test]
    fn callers_sharing_one_failing_profile_build_all_reject_and_the_next_call_builds_again() {
        let temp = tempfile::tempdir().expect("temp folder");
        let profiles = Profiles::new(temp.path().to_path_buf());
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let builds = AtomicUsize::new(0);
        let outcomes = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                profiles.shared_dir_with(&Unlaned, &|step, _| {
                    if step == Step::UserFolder {
                        builds.fetch_add(1, Ordering::SeqCst);
                        // The build is held until a second caller has joined it.
                        drop(gate.lock().expect("gate").recv_timeout(Duration::from_secs(30)));
                        return Err(disk_full());
                    }
                    Ok(())
                })
            });
            while !profiles.building() {
                std::thread::yield_now();
            }
            let second = scope.spawn(|| profiles.shared_dir(&Unlaned));
            std::thread::sleep(Duration::from_millis(200));
            release.send(()).expect("release the build");
            [first.join().expect("first"), second.join().expect("second")]
        });
        for outcome in &outcomes {
            let error = outcome.as_ref().expect_err("every caller of the failed build is rejected");
            assert!(!error.message.contains(temp.path().to_str().expect("utf-8")), "{}", error.message);
        }
        assert_eq!(builds.load(Ordering::SeqCst), 1, "one build served both");
        assert!(folders_of(temp.path()).is_empty());
        let profile = profiles.shared_dir(&Unlaned).expect("the next call builds again");
        assert_eq!(profiles.shared_dir(&Unlaned).expect("shared"), profile);
    }

    #[test]
    fn the_private_profile_starts_with_macros_locked_down() {
        let temp = tempfile::tempdir().expect("temp folder");
        let profiles = Profiles::new(temp.path().to_path_buf());
        let profile = profiles.shared_dir(&Unlaned).expect("profile");
        let registry = std::fs::read_to_string(profile.join("user").join("registrymodifications.xcu")).expect("registry");
        assert_eq!(registry, MACRO_LOCKDOWN_REGISTRY);
        profiles.discard(&Unlaned);
        assert!(!profile.exists(), "a dropped profile is removed");
        let rebuilt = profiles.shared_dir(&Unlaned).expect("a clean copy");
        profiles.remove_all(&Unlaned);
        assert!(!rebuilt.exists());
    }

    #[test]
    fn a_scratch_folder_that_cannot_be_removed_is_retried_and_then_logged_not_swallowed() {
        let attempts = AtomicUsize::new(0);
        let logged = Mutex::new(Vec::new());
        let busy = |_: &Path| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::from_raw_os_error(if cfg!(windows) { 32 } else { 16 }))
        };
        let dir = Path::new("scratch").join("mixdog-office-legacy-x");
        remove_directory_with_retry(&Unlaned, &dir, &busy, &|line| lock(&logged).push(line.to_owned()), Duration::from_millis(1));
        assert_eq!(attempts.load(Ordering::SeqCst), 6);
        let logged = lock(&logged);
        assert_eq!(logged.len(), 1);
        assert!(logged[0].starts_with(&format!("scratch folder {} could not be removed: ", dir.display())), "{}", logged[0]);
        assert!(logged[0].contains("EBUSY") && logged[0].ends_with('\n'), "{}", logged[0]);
    }

    #[test]
    fn an_error_that_is_not_busy_is_logged_at_once() {
        let attempts = AtomicUsize::new(0);
        let logged = Mutex::new(Vec::new());
        let refused = |_: &Path| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::other("refused"))
        };
        remove_directory_with_retry(&Unlaned, Path::new("scratch"), &refused, &|line| lock(&logged).push(line.to_owned()), Duration::from_millis(1));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(*lock(&logged), ["scratch folder scratch could not be removed: refused\n"]);
    }

    #[test]
    fn a_message_never_names_a_private_folder_however_it_was_written() {
        let hidden = if cfg!(windows) { Path::new("C:\\Temp\\mixdog-office-legacy-ab12cd") } else { Path::new("/tmp/mixdog-office-legacy-ab12cd") };
        let native = hidden.display().to_string();
        let slashed = native.replace('\\', "/");
        let text = format!("could not copy {native}\\out.xlsx or {slashed}/out.xlsx or {}", file_url(hidden));
        let redacted = redact_directories(&text, &[hidden]);
        assert!(!redacted.contains("mixdog-office-legacy"), "{redacted}");
        assert!(redacted.contains("could not copy"), "{redacted}");
    }
}

impl std::error::Error for ProfileError {}
