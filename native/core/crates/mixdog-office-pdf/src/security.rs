//! `pdf/pdf-security.mjs`: encrypting a PDF with AES-256 and decrypting one, by qpdf. qpdf stays an external program: on
//! `PATH`, or where `MIXDOG_QPDF_PATH` points (the Windows installer does not add itself to `PATH`).
//!
//! Every run is bounded (a qpdf waiting on a prompt or a file it cannot finish would otherwise hold the call open with
//! nothing to report). Passwords travel in a response file of mode 0600 beside the output, never on the command line
//! where other processes can read them; qpdf takes each line of it as one literal argument, so a line break is the one
//! character a password cannot carry. An input that is also the output goes through a temporary sibling and a rename.
//!
//! The run itself is async work (`tokio::process`); the calls of this crate are blocking jobs, so it runs on a runtime
//! of its own, which is why these functions are for a lane thread, never for a runtime worker.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use mixdog_fsio::{OpenOptions, WriteProof};
use mixdog_js::js_to_lowercase;
use mixdog_office_base::write_note::WriteNote;
use serde_json::{Value, json};

use crate::document::AnalysisError;

/// How long a probe for qpdf may take.
const QPDF_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long one qpdf run may take.
const QPDF_RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// What the caller is told when qpdf is not there.
pub const QPDF_INSTALL_HINT: &str = "PDF encryption/decryption requires qpdf on PATH (or MIXDOG_QPDF_PATH) and it is not installed (Windows: winget install qpdf; macOS: brew install qpdf; Debian/Ubuntu: apt install qpdf); tell the user the file was left as is";

/// What the caller is told about a password qpdf's response file cannot carry.
pub const PASSWORD_LINE_BREAK: &str = "PDF passwords cannot contain line breaks; the file was left as is";

/// A program that answered stays found for the life of the process; a negative answer is probed again, because the
/// user may install qpdf and retry without restarting.
static QPDF_FOUND: AtomicBool = AtomicBool::new(false);

/// `process.env.MIXDOG_QPDF_PATH || 'qpdf'`.
fn qpdf_program() -> String {
    std::env::var("MIXDOG_QPDF_PATH").ok().filter(|path| !path.is_empty()).unwrap_or_else(|| "qpdf".to_owned())
}

/// `run(command, args, timeoutMs)`: Ok when the program exits 0, else the text of what went wrong (its stderr, else its
/// stdout, else the exit code).
fn run(program: &str, args: &[String], timeout: Duration) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let mut command = tokio::process::Command::new(program);
        command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        // CREATE_NO_WINDOW.
        command.creation_flags(0x0800_0000);
        match mixdog_rt::time::timeout(timeout, command.output()).await {
            Err(_) => Err(format!("qpdf timed out after {} seconds", timeout.as_secs())),
            Ok(Err(error)) => Err(match error.kind() {
                std::io::ErrorKind::NotFound => format!("spawn {program} ENOENT"),
                std::io::ErrorKind::PermissionDenied => format!("spawn {program} EACCES"),
                _ => error.to_string(),
            }),
            Ok(Ok(output)) if output.status.success() => Ok(()),
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let code = output.status.code().map_or_else(|| "null".to_owned(), |code| code.to_string());
                Err(if !stderr.trim().is_empty() {
                    stderr.trim().to_owned()
                } else if !stdout.trim().is_empty() {
                    stdout.trim().to_owned()
                } else {
                    format!("qpdf exited with code {code}")
                })
            }
        }
    })
}

/// `qpdfAvailable()`: whether qpdf answers on this machine.
pub fn qpdf_available() -> bool {
    if QPDF_FOUND.load(Ordering::Relaxed) {
        return true;
    }
    if run(&qpdf_program(), &["--version".to_owned()], QPDF_PROBE_TIMEOUT).is_ok() {
        QPDF_FOUND.store(true, Ordering::Relaxed);
        return true;
    }
    false
}

/// What `securePdf` was asked: `mode` is `encrypt`, anything else decrypts.
#[derive(Debug, Clone, Copy)]
pub struct SecureRequest<'a> {
    pub input: &'a str,
    pub output: &'a str,
    pub mode: &'a str,
    pub password: &'a str,
    pub owner_password: &'a str,
}

/// Where a run writes and what it passes: the arguments qpdf reads from the response file, the file the result goes to
/// first, the response file, and whether the output is the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurePlan {
    pub args: Vec<String>,
    pub target: PathBuf,
    pub response: PathBuf,
    pub same_path: bool,
}

/// A password with a line break cannot go in a response file.
pub fn check_passwords(password: &str, owner_password: &str) -> Result<(), AnalysisError> {
    if password.contains(['\r', '\n']) || owner_password.contains(['\r', '\n']) {
        return Err(AnalysisError::plain(PASSWORD_LINE_BREAK));
    }
    Ok(())
}

fn directory_of(path: &str) -> PathBuf {
    match Path::new(path).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// The arguments, the temporary sibling and the response file of a run; `id` makes their names unique.
pub fn plan_secure(request: &SecureRequest<'_>, id: &str) -> SecurePlan {
    let same_path = js_to_lowercase(request.input) == js_to_lowercase(request.output);
    let target = if same_path { directory_of(request.output).join(format!(".mixdog-qpdf-{id}.pdf")) } else { PathBuf::from(request.output) };
    let response = directory_of(&target.to_string_lossy()).join(format!(".mixdog-qpdf-{id}.args"));
    let target_text = target.to_string_lossy().into_owned();
    let args = if request.mode == "encrypt" {
        let owner = if request.owner_password.is_empty() { request.password } else { request.owner_password };
        vec!["--encrypt".to_owned(), request.password.to_owned(), owner.to_owned(), "256".to_owned(), "--".to_owned(), request.input.to_owned(), target_text]
    } else {
        vec![format!("--password={}", request.password), "--decrypt".to_owned(), request.input.to_owned(), target_text]
    };
    SecurePlan { args, target, response, same_path }
}

/// The response file's text: one argument per line.
pub fn response_text(args: &[String]) -> String {
    format!("{}\n", args.join("\n"))
}

fn write_response<P: WriteProof>(proof: &P, path: &Path, text: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(proof, path)?;
    file.write_all(text.as_bytes())
}

/// `securePdf({ input, output, mode, password, ownerPassword })`: `{ ok, mode, input, output }` once qpdf has written the
/// output. A run that fails leaves no response file and no temporary sibling behind.
pub fn secure_pdf<P: WriteProof>(proof: &P, note: &dyn WriteNote, request: &SecureRequest<'_>) -> Result<Value, AnalysisError> {
    if !qpdf_available() {
        return Err(AnalysisError::plain(QPDF_INSTALL_HINT));
    }
    check_passwords(request.password, request.owner_password)?;
    let plan = plan_secure(request, &uuid::Uuid::new_v4().to_string());
    write_response(proof, &plan.response, &response_text(&plan.args)).map_err(|error| AnalysisError::plain(error.to_string()))?;
    note.note_write(Path::new(request.output));
    let outcome = run(&qpdf_program(), &[format!("@{}", plan.response.display())], QPDF_RUN_TIMEOUT).and_then(|()| {
        if plan.same_path {
            mixdog_fsio::rename(proof, &plan.target, request.output).map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    // Whatever happened, the response file (it holds the passwords) and the temporary sibling go.
    let _ = mixdog_fsio::remove_file(proof, &plan.response);
    if plan.same_path {
        let _ = mixdog_fsio::remove_file(proof, &plan.target);
    }
    outcome.map_err(AnalysisError::plain)?;
    Ok(json!({ "ok": true, "mode": request.mode, "input": request.input, "output": request.output }))
}
