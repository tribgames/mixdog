//! The clipboard, paste and OS helpers against fake helper programs.
//!
//! A [`FakeRunner`] stands in for the system's programs on every platform: it records each command (argv, environment,
//! stdin bytes, timeout) and answers what the test scripted, so the chosen helper and its input are asserted per
//! platform without that platform. On Unix a second set of tests puts fake `pbcopy`, `xclip`, `wl-paste` and the like in a
//! temporary folder and runs them through the real [`SystemRunner`], so the spawn, the stdin hand-over, the capture, the
//! exit code and the timeout are those of a real child.

use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_fsio::Unlaned;
use mixdog_term::clipboard::{ClipboardError, CopyOutcome, OSC52_MAX_BYTES, copy_to_clipboard_with};
use mixdog_term::os::{HelperCommand, Outcome, Platform, Runner};
use mixdog_term::paste::{
    AttachmentSource, ImageAttachment, ResizeRequest, ResizedImage, Resizer, image_attachment_from_buffer, read_clipboard_image_attachment,
    read_clipboard_text, read_image_attachment_from_path,
};

const WAIT: Duration = Duration::from_secs(10);

/// Answers scripted outcomes in order and records every command; a hook may act on a command first (to write the file a
/// real helper would write).
struct FakeRunner {
    outcomes: Mutex<VecDeque<Outcome>>,
    commands: Mutex<Vec<HelperCommand>>,
    sent: Mutex<Sender<HelperCommand>>,
    hook: Box<dyn Fn(&HelperCommand) + Send + Sync>,
}

impl FakeRunner {
    fn new(outcomes: Vec<Outcome>) -> (Arc<FakeRunner>, Receiver<HelperCommand>) {
        FakeRunner::with_hook(outcomes, |_| {})
    }

    fn with_hook(outcomes: Vec<Outcome>, hook: impl Fn(&HelperCommand) + Send + Sync + 'static) -> (Arc<FakeRunner>, Receiver<HelperCommand>) {
        let (sender, receiver) = mpsc::channel();
        let runner = FakeRunner { outcomes: Mutex::new(outcomes.into()), commands: Mutex::new(Vec::new()), sent: Mutex::new(sender), hook: Box::new(hook) };
        (Arc::new(runner), receiver)
    }

    fn commands(&self) -> Vec<HelperCommand> {
        self.commands.lock().unwrap().clone()
    }
}

impl Runner for FakeRunner {
    fn run(&self, command: &HelperCommand) -> Outcome {
        (self.hook)(command);
        self.commands.lock().unwrap().push(command.clone());
        let _ = self.sent.lock().unwrap().send(command.clone());
        self.outcomes.lock().unwrap().pop_front().unwrap_or(Outcome::NotFound)
    }

    fn spawn_detached(&self, _program: &str, _args: &[String]) -> io::Result<()> {
        Ok(())
    }
}

fn exited(code: i32, stdout: &[u8]) -> Outcome {
    Outcome::Exited { code: Some(code), stdout: stdout.to_vec() }
}

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let map: Vec<(String, String)> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    move |name| map.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

// ---- copying --------------------------------------------------------------------------------------------------------------

#[test]
fn windows_without_a_remote_session_copies_through_clip_exe_only() {
    let (runner, _) = FakeRunner::new(vec![exited(0, b"")]);
    let mut out = Vec::new();
    let result = copy_to_clipboard_with(&mut out, "h\u{e9}llo", false, Platform::Windows, &env_of(&[]), runner.clone());
    assert_eq!(result, Ok(CopyOutcome::Copied));
    assert!(out.is_empty(), "no OSC 52 on native Windows");
    let commands = runner.commands();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].program, "clip.exe");
    assert_eq!(commands[0].stdin, Some("h\u{e9}llo".encode_utf16().flat_map(u16::to_le_bytes).collect()));
    assert_eq!(commands[0].timeout, None);
}

#[test]
fn an_osc52_write_answers_at_once_and_the_helper_runs_on_its_own() {
    let (runner, received) = FakeRunner::new(vec![exited(0, b"")]);
    let mut out = Vec::new();
    let env = env_of(&[("WAYLAND_DISPLAY", "wayland-0")]);
    let result = copy_to_clipboard_with(&mut out, "hi", false, Platform::Linux, &env, runner);
    assert_eq!(result, Ok(CopyOutcome::Terminal));
    assert_eq!(out, b"\x1b]52;c;aGk=\x07");
    let command = received.recv_timeout(WAIT).expect("the helper was started");
    assert_eq!((command.program.as_str(), command.stdin), ("wl-copy", Some(b"hi".to_vec())));
}

#[test]
fn osc52_goes_through_the_tmux_passthrough() {
    let (runner, _received) = FakeRunner::new(vec![exited(0, b"")]);
    let mut out = Vec::new();
    let env = env_of(&[("TMUX", "/tmp/tmux-1/default,1,0")]);
    let _ = copy_to_clipboard_with(&mut out, "hi", false, Platform::Windows, &env, runner);
    assert_eq!(out, b"\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
}

#[test]
fn a_confirmed_copy_waits_for_the_helper_even_after_osc52() {
    let (runner, _) = FakeRunner::new(vec![exited(0, b"")]);
    let mut out = Vec::new();
    let result = copy_to_clipboard_with(&mut out, "x", true, Platform::Macos, &env_of(&[]), runner.clone());
    assert_eq!(result, Ok(CopyOutcome::Copied));
    assert!(!out.is_empty());
    assert_eq!(runner.commands()[0].program, "pbcopy");
    // A helper failure does not matter when OSC 52 covered the copy.
    let (runner, _) = FakeRunner::new(vec![exited(1, b"")]);
    let result = copy_to_clipboard_with(&mut Vec::new(), "x", true, Platform::Macos, &env_of(&[]), runner);
    assert_eq!(result, Ok(CopyOutcome::Terminal));
}

#[test]
fn a_helper_failure_is_an_error_when_osc52_was_left_out() {
    let big = "x".repeat(OSC52_MAX_BYTES + 1);
    let run = |platform: Platform, outcome: Outcome| {
        let (runner, _) = FakeRunner::new(vec![outcome]);
        copy_to_clipboard_with(&mut Vec::new(), &big, false, platform, &env_of(&[]), runner)
    };
    assert_eq!(
        run(Platform::Linux, Outcome::NotFound),
        Err(ClipboardError(
            "xclip is not installed; install wl-clipboard (Wayland) or xclip (X11), for example `sudo apt install wl-clipboard xclip`".to_owned()
        ))
    );
    assert_eq!(run(Platform::Macos, Outcome::NotFound), Err(ClipboardError("spawn pbcopy ENOENT".to_owned())));
    assert_eq!(run(Platform::Linux, exited(3, b"")), Err(ClipboardError("xclip exited with code 3".to_owned())));
    assert_eq!(run(Platform::Linux, Outcome::Exited { code: None, stdout: Vec::new() }), Err(ClipboardError("xclip exited with code null".to_owned())));
    assert_eq!(run(Platform::Linux, exited(0, b"")), Ok(CopyOutcome::Copied));
}

// ---- reading the clipboard ----------------------------------------------------------------------------------------------

#[test]
fn clipboard_text_is_read_by_the_helper_of_each_platform() {
    let (runner, _) = FakeRunner::new(vec![exited(0, b"aMOpbGxvIOKCrA==\r\n")]);
    assert_eq!(read_clipboard_text(Platform::Windows, runner.as_ref()), Ok("h\u{e9}llo \u{20ac}".to_owned()));
    let command = runner.commands().remove(0);
    assert_eq!(command.program, "powershell.exe");
    assert_eq!(command.args[..4], ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert_eq!(command.timeout, Some(Duration::from_secs(3)));

    let (runner, _) = FakeRunner::new(vec![exited(2, b"")]);
    assert_eq!(read_clipboard_text(Platform::Windows, runner.as_ref()), Ok(String::new()));

    let (runner, _) = FakeRunner::new(vec![exited(0, "caf\u{e9}".as_bytes())]);
    assert_eq!(read_clipboard_text(Platform::Macos, runner.as_ref()), Ok("caf\u{e9}".to_owned()));
    assert_eq!(runner.commands()[0].program, "pbpaste");

    assert_eq!(read_clipboard_text(Platform::Other, FakeRunner::new(vec![]).0.as_ref()), Ok(String::new()));
}

#[test]
fn linux_reads_wayland_then_x11_and_names_the_package_when_neither_exists() {
    let (runner, _) = FakeRunner::new(vec![exited(1, b""), exited(0, b"from x")]);
    assert_eq!(read_clipboard_text(Platform::Linux, runner.as_ref()), Ok("from x".to_owned()));
    let commands = runner.commands();
    assert_eq!((commands[0].program.as_str(), commands[0].args.clone()), ("wl-paste", vec!["--no-newline".to_owned()]));
    assert_eq!(commands[1].program, "xclip");
    assert_eq!(commands[1].args, ["-selection", "clipboard", "-o"]);

    let (runner, _) = FakeRunner::new(vec![Outcome::NotFound, Outcome::NotFound]);
    let error = read_clipboard_text(Platform::Linux, runner.as_ref()).unwrap_err();
    assert!(error.starts_with("no clipboard reader is installed; install wl-clipboard"));
    let (runner, _) = FakeRunner::new(vec![Outcome::NotFound, exited(1, b"")]);
    assert_eq!(read_clipboard_text(Platform::Linux, runner.as_ref()), Ok(String::new()));
}

fn echo_resize<'a>(seen: &'a Mutex<Vec<(Vec<u8>, String, String, String)>>) -> impl Fn(&ResizeRequest<'_>) -> Result<ResizedImage, String> + 'a {
    move |request| {
        seen.lock().unwrap().push((request.bytes.to_vec(), request.mime_type.to_owned(), request.label.to_owned(), request.provider.to_owned()));
        Ok(ResizedImage { data: "RESIZED".to_owned(), media_type: "image/png".to_owned(), metadata_text: Some("[Image: meta]".to_owned()) })
    }
}

#[test]
fn the_clipboard_image_of_linux_comes_from_wl_paste_then_xclip() {
    let seen = Mutex::new(Vec::new());
    let resize = echo_resize(&seen);
    let (runner, _) = FakeRunner::new(vec![exited(0, b""), exited(0, b"\x89PNG")]);
    let attachment = read_clipboard_image_attachment(Platform::Linux, runner.as_ref(), "openai", &resize).unwrap().unwrap();
    assert_eq!(
        attachment,
        ImageAttachment {
            content: "RESIZED".to_owned(),
            media_type: "image/png".to_owned(),
            filename: "Pasted image".to_owned(),
            source_path: String::new(),
            metadata_text: Some("[Image: meta]".to_owned()),
        }
    );
    assert_eq!(seen.lock().unwrap()[0], (b"\x89PNG".to_vec(), "image/png".to_owned(), "Pasted image".to_owned(), "openai".to_owned()));
    let commands = runner.commands();
    assert_eq!(commands[0].args, ["--type", "image/png"]);
    assert_eq!(commands[1].args, ["-selection", "clipboard", "-t", "image/png", "-o"]);
    assert!(commands.iter().all(|command| command.timeout == Some(Duration::from_secs(3))));

    let (runner, _) = FakeRunner::new(vec![Outcome::NotFound, Outcome::NotFound]);
    let error = read_clipboard_image_attachment(Platform::Linux, runner.as_ref(), "", &resize).unwrap_err();
    assert!(error.starts_with("no clipboard reader is installed"));
    let (runner, _) = FakeRunner::new(vec![exited(1, b""), Outcome::NotFound]);
    assert_eq!(read_clipboard_image_attachment(Platform::Linux, runner.as_ref(), "", &resize), Ok(None));
}

#[test]
fn the_clipboard_image_of_windows_is_saved_by_powershell_and_the_file_is_removed() {
    let seen = Mutex::new(Vec::new());
    let resize = echo_resize(&seen);
    let saved: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let saved_by_hook = Arc::clone(&saved);
    let (runner, _) = FakeRunner::with_hook(vec![exited(0, b"")], move |command| {
        let path = command
            .env
            .iter()
            .find(|(name, _)| name == "MIXDOG_CLIPBOARD_IMAGE_PATH")
            .map(|(_, value)| PathBuf::from(value))
            .expect("the path is handed over in the environment");
        mixdog_fsio::write(&Unlaned, &path, b"PNGBYTES").unwrap();
        *saved_by_hook.lock().unwrap() = Some(path);
    });
    let attachment = read_clipboard_image_attachment(Platform::Windows, runner.as_ref(), "", &resize).unwrap().unwrap();
    assert_eq!(attachment.content, "RESIZED");
    assert_eq!(seen.lock().unwrap()[0].0, b"PNGBYTES");
    let path = saved.lock().unwrap().clone().unwrap();
    assert!(!mixdog_fsio::exists(&Unlaned, &path).unwrap(), "the temporary file is removed");
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("mixdog-clipboard-") && name.ends_with(".png"), "{name}");
    let command = runner.commands().remove(0);
    assert_eq!(command.program, "powershell.exe");
    assert!(command.args[4].starts_with("$p=$env:MIXDOG_CLIPBOARD_IMAGE_PATH;"));
    assert_eq!(command.timeout, Some(Duration::from_secs(5)));

    // No image on the clipboard: PowerShell exits 2 and writes nothing.
    let (runner, _) = FakeRunner::new(vec![exited(2, b"")]);
    assert_eq!(read_clipboard_image_attachment(Platform::Windows, runner.as_ref(), "", &resize), Ok(None));
}

#[test]
fn the_clipboard_image_of_macos_is_saved_by_osascript() {
    let seen = Mutex::new(Vec::new());
    let resize = echo_resize(&seen);
    let (runner, _) = FakeRunner::with_hook(vec![exited(0, b"")], |command| {
        let script = &command.args[1];
        let start = script.find("POSIX file \"").unwrap() + "POSIX file \"".len();
        let end = start + script[start..].find('"').unwrap();
        mixdog_fsio::write(&Unlaned, &script[start..end], b"MACPNG").unwrap();
    });
    let attachment = read_clipboard_image_attachment(Platform::Macos, runner.as_ref(), "", &resize).unwrap().unwrap();
    assert_eq!(attachment.content, "RESIZED");
    assert_eq!(seen.lock().unwrap()[0].0, b"MACPNG");
    let command = runner.commands().remove(0);
    assert_eq!((command.program.as_str(), command.args[0].as_str()), ("osascript", "-e"));
    assert!(command.args[1].starts_with("set png_data to (the clipboard as \u{ab}class PNGf\u{bb})\n"));
}

// ---- attachments ------------------------------------------------------------------------------------------------------

#[test]
fn an_attachment_from_bytes_goes_through_the_callers_resize() {
    let seen = Mutex::new(Vec::new());
    let resize = echo_resize(&seen);
    assert_eq!(image_attachment_from_buffer(b"", "image/png", &AttachmentSource::default(), &resize), Err("image is empty".to_owned()));
    let failing: Resizer<'_> = &|_| Err("image exceeds inline API size limit; resize it first".to_owned());
    assert_eq!(
        image_attachment_from_buffer(b"x", "image/png", &AttachmentSource::default(), failing),
        Err("image exceeds inline API size limit; resize it first".to_owned())
    );
}

fn temp_folder() -> tempfile::TempDir {
    tempfile::tempdir().expect("a temporary folder")
}

#[test]
fn an_image_path_is_read_from_the_folder_it_is_relative_to() {
    let dir = temp_folder();
    mixdog_fsio::write(&Unlaned, dir.path().join("shot.PNG"), b"IMG").unwrap();
    mixdog_fsio::create_dir(&Unlaned, dir.path().join("folder.png")).unwrap();
    let seen = Mutex::new(Vec::new());
    let resize = echo_resize(&seen);
    let read = |raw: &str| read_image_attachment_from_path(raw, Some(dir.path()), "grok", Platform::current(), &resize);

    let attachment = read("./sub/../shot.PNG").unwrap().unwrap();
    let full = dir.path().join("shot.PNG").to_string_lossy().into_owned();
    assert_eq!((attachment.filename.as_str(), attachment.source_path.as_str()), ("shot.PNG", full.as_str()));
    let (bytes, mime, label, provider) = seen.lock().unwrap()[0].clone();
    assert_eq!((bytes, mime.as_str(), label.as_str(), provider.as_str()), (b"IMG".to_vec(), "image/png", full.as_str(), "grok"));

    assert_eq!(read("missing.png"), Ok(None));
    assert_eq!(read("folder.png"), Ok(None));
    assert_eq!(read("notes.txt"), Ok(None));
    let quoted = format!("\"{full}\"");
    assert_eq!(read(&quoted).unwrap().unwrap().content, "RESIZED");
}

// ---- real child processes (Unix) ------------------------------------------------------------------------------------

#[cfg(unix)]
mod real_children {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use mixdog_term::os::SystemRunner;

    use super::*;

    /// Writes an executable shell script named `name` into `dir`.
    fn fake(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        mixdog_fsio::write(&Unlaned, &path, format!("#!/bin/sh\n{body}\n")).unwrap();
        mixdog_fsio::set_permissions(&Unlaned, &path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Runs the system's runner with the program looked up in `dir` first, as a `PATH` that starts with it would.
    struct InDir(PathBuf);

    impl Runner for InDir {
        fn run(&self, command: &HelperCommand) -> Outcome {
            let mut command = command.clone();
            let candidate = self.0.join(&command.program);
            if mixdog_fsio::exists(&Unlaned, &candidate).unwrap_or(false) {
                command.program = candidate.to_string_lossy().into_owned();
            }
            SystemRunner.run(&command)
        }

        fn spawn_detached(&self, program: &str, args: &[String]) -> io::Result<()> {
            SystemRunner.spawn_detached(program, args)
        }
    }

    fn read_log(path: &Path) -> String {
        mixdog_fsio::read_to_string(&Unlaned, path).unwrap_or_default()
    }

    #[test]
    fn pbcopy_receives_the_text_on_stdin() {
        let dir = temp_folder();
        let log = dir.path().join("stdin.bin");
        fake(dir.path(), "pbcopy", &format!("cat > '{}'", log.display()));
        let runner: Arc<dyn Runner> = Arc::new(InDir(dir.path().to_path_buf()));
        let result = copy_to_clipboard_with(&mut Vec::new(), "caf\u{e9} \u{1F600}", true, Platform::Macos, &env_of(&[]), runner);
        assert_eq!(result, Ok(CopyOutcome::Copied));
        assert_eq!(read_log(&log), "caf\u{e9} \u{1F600}");
    }

    #[test]
    fn xclip_receives_its_arguments_and_a_failure_is_reported() {
        let dir = temp_folder();
        let args = dir.path().join("args.txt");
        fake(dir.path(), "xclip", &format!("echo \"$@\" > '{}'; cat > /dev/null; exit 4", args.display()));
        let runner: Arc<dyn Runner> = Arc::new(InDir(dir.path().to_path_buf()));
        let big = "x".repeat(OSC52_MAX_BYTES + 1);
        let result = copy_to_clipboard_with(&mut Vec::new(), &big, false, Platform::Linux, &env_of(&[]), runner);
        assert_eq!(result, Err(ClipboardError("xclip exited with code 4".to_owned())));
        assert_eq!(read_log(&args).trim(), "-selection clipboard");
    }

    #[test]
    fn a_helper_that_is_missing_is_not_found_and_a_slow_one_times_out() {
        let missing = SystemRunner.run(&HelperCommand::new("/nonexistent-dir/none", &[]));
        assert_eq!(missing, Outcome::NotFound);
        let dir = temp_folder();
        fake(dir.path(), "slow", "exec sleep 30");
        let slow = HelperCommand { timeout: Some(Duration::from_millis(150)), ..HelperCommand::new(&dir.path().join("slow").to_string_lossy(), &[]) };
        assert_eq!(SystemRunner.run(&slow), Outcome::TimedOut);
    }

    #[test]
    fn stdout_is_captured_and_capped() {
        let dir = temp_folder();
        fake(dir.path(), "emit", "printf 'one two'; exit 0");
        let mut command = HelperCommand::new(&dir.path().join("emit").to_string_lossy(), &[]);
        command.capture_stdout = true;
        assert_eq!(SystemRunner.run(&command), Outcome::Exited { code: Some(0), stdout: b"one two".to_vec() });
        command.max_stdout = Some(3);
        assert_eq!(SystemRunner.run(&command), Outcome::Overflow);
    }

    #[test]
    fn wl_paste_output_becomes_the_clipboard_text() {
        let dir = temp_folder();
        fake(dir.path(), "wl-paste", "printf '%s' \"$*\"");
        let runner = InDir(dir.path().to_path_buf());
        assert_eq!(read_clipboard_text(Platform::Linux, &runner), Ok("--no-newline".to_owned()));
    }
}
