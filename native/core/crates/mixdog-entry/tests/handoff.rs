//! What `mixdog` hands to the `mixdogd` installed beside it (`exec` and the helper subcommands): only that one runs, whatever this
//! program's own file name, and a missing one or one of another build is refused with exit 1. The scenario that needs a built
//! `mixdogd` (`MIXDOGD_BIN`, or the one beside the test's `mixdog`) runs with `-- --ignored`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test lays out an install, runs its programs and is a listener")]

#[path = "support/sandbox.rs"]
mod sandbox;

use std::ffi::OsString;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use sandbox::Sandbox;

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() }
}

/// `from` laid out as `dir/name` (a hard link, else a copy).
fn place(from: &Path, dir: &Path, name: &str) -> PathBuf {
    let to = dir.join(name);
    std::fs::hard_link(from, &to).or_else(|_| std::fs::copy(from, &to).map(drop)).unwrap_or_else(|error| panic!("laying out {}: {error}", from.display()));
    to
}

fn scratch(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir_in(mixdog_testkit::target_tmpdir!()).unwrap()
}

fn terminal() -> PathBuf {
    PathBuf::from(mixdog_testkit::bin_exe!("mixdog"))
}

/// The `mixdogd` built beside the test's `mixdog`, or the one `MIXDOGD_BIN` names.
fn built_mixdogd() -> PathBuf {
    std::env::var_os("MIXDOGD_BIN").filter(|bin| !bin.is_empty()).map_or_else(|| terminal().with_file_name(exe("mixdogd")), PathBuf::from)
}

/// Runs `program args` in the sandbox, with `env` over its environment, to its end.
fn run(program: &Path, args: &[&str], sandbox: &Sandbox, env: &[(&str, OsString)]) -> Output {
    let mut base = sandbox.env();
    base.retain(|(name, _)| !env.iter().any(|(set, _)| name == set));
    let mut command = Command::new(program);
    command.args(args).current_dir(sandbox.work()).env_clear().envs(base).envs(env.iter().map(|(name, value)| (name, value)));
    command.stdin(Stdio::null()).output().unwrap_or_else(|error| panic!("running {}: {error}", program.display()))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `program ext-worker` once it has sent the extension host's READY frame on its stdout, and what reads the rest of that stdout:
/// it answers once the stream ends, that is once every process holding it ended.
fn ready_worker(program: &Path) -> (std::process::Child, mpsc::Receiver<std::io::Result<Vec<u8>>>) {
    let mut worker = Command::new(program).arg("ext-worker").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("the worker starts");
    let ready = mixdog_exthost_worker::wire::ready();
    let mut stdout = worker.stdout.take().expect("stdout");
    let (sent, read) = mpsc::channel();
    let length = ready.len();
    std::thread::spawn(move || {
        let mut frame = vec![0; length];
        if sent.send(stdout.read_exact(&mut frame).map(|()| frame)).is_ok() {
            let mut rest = Vec::new();
            let _ = sent.send(stdout.read_to_end(&mut rest).map(|_| rest));
        }
    });
    let frame = read.recv_timeout(Duration::from_secs(120)).expect("the worker's first frame").expect("the frame is read");
    assert_eq!(frame, ready.to_vec(), "the worker's first frame is READY");
    (worker, read)
}

/// A `mixdogd` elsewhere (on the search path, or the one `MIXDOGD_BIN` names) never stands in for the missing one beside the
/// program, and the program's file name decides nothing: laid out under the desktop's `Mixdog` name it still answers `--help`.
#[test]
fn without_a_mixdogd_beside_it_an_exec_or_a_helper_is_refused_and_none_elsewhere_runs() {
    let sandbox = Sandbox::new();
    let install = scratch("handoff-install-");
    let program = place(&terminal(), install.path(), &exe("Mixdog"));
    // Were it run, this `mixdogd` would answer its version with nothing, a refusal other than the one asserted.
    let elsewhere = scratch("handoff-elsewhere-");
    let other = place(&terminal(), elsewhere.path(), &exe("mixdogd"));
    let path = std::env::join_paths(std::iter::once(elsewhere.path().to_path_buf()).chain(std::env::split_paths(&sandbox::path_without_node()))).unwrap();
    let env = [("PATH", path), ("MIXDOGD_BIN", other.into_os_string())];
    for args in [&["exec", "hi"][..], &["ext-worker"], &["--provider", "p", "Exec", "say", "hi"]] {
        let output = run(&program, args, &sandbox, &env);
        let (out, err) = (text(&output.stdout), text(&output.stderr));
        assert_eq!((output.status.code(), out.as_str()), (Some(1), ""), "{args:?}: {err}");
        let named = err
            .strip_prefix("mixdog: ")
            .and_then(|rest| rest.strip_suffix(" is missing: this program runs `exec` and the core's helpers on the mixdogd installed beside it\n"))
            .unwrap_or_else(|| panic!("{args:?}: {err}"));
        let named = Path::new(named);
        assert_eq!(named.file_name(), Some(exe("mixdogd").as_ref()), "{err}");
        assert_eq!(named.parent().unwrap().canonicalize().unwrap(), install.path().canonicalize().unwrap(), "{err}");
    }
    let help = run(&program, &["--help"], &sandbox, &env);
    assert_eq!((help.status.code(), text(&help.stdout), text(&help.stderr)), (Some(0), mixdog_launch::command::HELP_TEXT.to_owned(), String::new()));
}

/// A `mixdogd` beside the program that does not report this build's version is refused before it is handed the line: here the
/// terminal program itself, laid out as the `mixdogd`, which has no `--version`.
#[test]
fn a_mixdogd_of_another_build_beside_it_is_refused() {
    let sandbox = Sandbox::new();
    let install = scratch("handoff-install-");
    let program = place(&terminal(), install.path(), &exe("mixdog"));
    place(&terminal(), install.path(), &exe("mixdogd"));
    let output = run(&program, &["exec", "hi"], &sandbox, &[]);
    let (out, err) = (text(&output.stdout), text(&output.stderr));
    assert_eq!((output.status.code(), out.as_str()), (Some(1), ""), "{err}");
    let own = format!(" reports \"\", not mixdogd {}: it is not the mixdogd of this program's version\n", env!("CARGO_PKG_VERSION"));
    assert!(err.starts_with("mixdog: ") && err.ends_with(&own), "{err}");
}

/// A helper line runs on the `mixdogd` beside the program with this process's streams, environment and exit status: the extension
/// worker's READY frame arrives on this program's stdout and it ends with success when its stdin closes; the judge host's refusal
/// of a missing option is its stderr and exit 2; the bridge reaches the listener its environment names, with its token.
#[test]
#[ignore = "needs a built mixdogd (MIXDOGD_BIN, or the one beside the test's mixdog)"]
fn a_helper_runs_on_the_mixdogd_beside_it_with_this_programs_streams_environment_and_exit_status() {
    let install = scratch("handoff-install-");
    let program = place(&terminal(), install.path(), &exe("mixdog"));
    place(&built_mixdogd(), install.path(), &exe("mixdogd"));

    let (mut worker, output) = ready_worker(&program);
    drop(worker.stdin.take());
    assert!(worker.wait().expect("the worker's exit").success(), "the worker ends when its pipe closes");
    output.recv_timeout(Duration::from_secs(60)).expect("the worker's stdout closes").expect("the rest is read");

    let dir = tempfile::tempdir().unwrap();
    let judge = Command::new(&program).args(["effort-judge-host", "--dir"]).arg(dir.path()).stdin(Stdio::null()).output().expect("the judge host runs");
    let stderr = text(&judge.stderr);
    assert_eq!(judge.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("--ort-library"), "{stderr}");

    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let port = listener.local_addr().expect("the port").port();
    let (heard, heads) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("the bridge's connection");
        let mut reader = BufReader::new(stream.try_clone().expect("the stream"));
        let (mut head, mut length) = (Vec::new(), 0_usize);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().unwrap_or(0);
            }
            head.push(line.trim().to_owned());
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).expect("the body");
        heard.send(head).expect("the test waits");
        let answer = r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#;
        write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len())
            .expect("the answer");
    });
    let mut bridge = Command::new(&program)
        .arg(mixdog_acp::mcp_bridge::SUBCOMMAND)
        .env(mixdog_acp::mcp_bridge::PORT_ENV, port.to_string())
        .env(mixdog_acp::mcp_bridge::TOKEN_ENV, "the-session-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the bridge starts");
    let mut stdin = bridge.stdin.take().expect("stdin");
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":7,"method":"tools/list"}}"#).expect("the message");
    let head = heads.recv_timeout(Duration::from_secs(120)).expect("the listener's request");
    assert!(head.iter().any(|line| line.eq_ignore_ascii_case("authorization: Bearer the-session-token")), "{head:?}");
    let mut answer = String::new();
    BufReader::new(bridge.stdout.take().expect("stdout")).read_line(&mut answer).expect("the answer's line");
    assert_eq!(answer.trim_end(), r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#);
    drop(stdin);
    assert!(bridge.wait().expect("the bridge's exit").success());
}

/// Ending the program ends the `mixdogd` it handed its run to, as it ended the run the program once made in its own process: the
/// worker's stdout closes once the program is killed, though the stdin the worker waits on stays open.
#[test]
#[ignore = "needs a built mixdogd (MIXDOGD_BIN, or the one beside the test's mixdog)"]
fn killing_the_program_ends_the_mixdogd_it_handed_its_run_to() {
    let install = scratch("handoff-install-");
    let program = place(&terminal(), install.path(), &exe("mixdog"));
    place(&built_mixdogd(), install.path(), &exe("mixdogd"));
    let (mut worker, output) = ready_worker(&program);
    let stdin = worker.stdin.take();
    worker.kill().expect("the program is killed");
    worker.wait().expect("the program's end");
    let ended = output.recv_timeout(Duration::from_secs(60));
    drop(stdin);
    ended.expect("the mixdogd outlived the program that handed it the run").expect("the rest is read");
}
