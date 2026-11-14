//! Tests of the askpass server (cases of the desktop's `ssh-auth.test.mjs`). The client side is a test client that
//! speaks the helper's wire (the `mixdog-askpass` binary is not started from a test).

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

type Answer = Box<dyn Fn(&AskpassQuestion) -> Option<String> + Send + Sync>;

/// Answers from a closure and records every question.
struct Scripted {
    answer: Answer,
    asked: Mutex<Vec<AskpassQuestion>>,
    running: AtomicUsize,
    peak: AtomicUsize,
    delay: Duration,
}

impl Scripted {
    fn new(answer: impl Fn(&AskpassQuestion) -> Option<String> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            answer: Box::new(answer),
            asked: Mutex::new(Vec::new()),
            running: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            delay: Duration::ZERO,
        })
    }

    fn slow(delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            answer: Box::new(|_| Some("x".to_owned())),
            asked: Mutex::new(Vec::new()),
            running: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            delay,
        })
    }

    fn questions(&self) -> Vec<AskpassQuestion> {
        self.asked.lock().unwrap().clone()
    }
}

#[async_trait]
impl AskpassPrompter for Scripted {
    async fn ask(&self, question: AskpassQuestion) -> Option<String> {
        let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        if !self.delay.is_zero() {
            mixdog_rt::time::sleep(self.delay).await;
        }
        let secret = (self.answer)(&question);
        self.asked.lock().unwrap().push(question);
        self.running.fetch_sub(1, Ordering::SeqCst);
        secret
    }
}

/// Never answers; records that its question was dropped.
struct Silent(Arc<AtomicBool>);

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl AskpassPrompter for Silent {
    async fn ask(&self, _question: AskpassQuestion) -> Option<String> {
        let _flag = DropFlag(self.0.clone());
        std::future::pending::<()>().await;
        None
    }
}

fn lane() -> DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

fn server(prompter: Arc<dyn AskpassPrompter>) -> AskpassServer {
    AskpassServer::new(prompter, lane(), Platform::current())
}

/// File-system steps of a test go through the durability lane, as the tree's other tests do.
async fn fs<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    on_lane(lane(), job).await.unwrap()
}

async fn is_dir(path: &Path) -> bool {
    let path = path.to_path_buf();
    fs(move |lane| mixdog_fsio::is_dir(lane, path)).await
}

async fn exists(path: &Path) -> bool {
    let path = path.to_path_buf();
    fs(move |lane| mixdog_fsio::exists(lane, path).unwrap()).await
}

async fn write_file(path: &Path, body: &'static [u8]) {
    let path = path.to_path_buf();
    fs(move |lane| mixdog_fsio::write(lane, path, body).unwrap()).await;
}

fn env_value(session: &AskpassSession, name: &str) -> String {
    session.env().into_iter().find(|(key, _)| key == name).map(|(_, value)| value).unwrap()
}

/// What the helper does: the request line out, the reply line in. `None` for a refusal or a closed endpoint.
async fn ask_over(endpoint: &str, request: &[u8]) -> Option<String> {
    let mut reply = Vec::new();
    #[cfg(unix)]
    {
        let mut stream = tokio::net::UnixStream::connect(endpoint).await.ok()?;
        stream.write_all(request).await.ok()?;
        stream.read_to_end(&mut reply).await.ok()?;
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        let mut stream = loop {
            match ClientOptions::new().open(endpoint) {
                Err(error) if error.raw_os_error() == Some(231) => mixdog_rt::time::sleep(Duration::from_millis(10)).await,
                other => break other.ok()?,
            }
        };
        stream.write_all(request).await.ok()?;
        stream.flush().await.ok()?;
        // The helper reads one line and leaves.
        let mut byte = [0u8; 1];
        while stream.read(&mut byte).await.ok()? == 1 {
            reply.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
    }
    let value: serde_json::Value = serde_json::from_slice(&reply).ok()?;
    (value["ok"] == true).then(|| value["secret"].as_str().map(str::to_owned)).flatten()
}

fn request(token: &str, prompt: &str) -> Vec<u8> {
    format!("{}\n", serde_json::json!({ "token": token, "prompt": prompt })).into_bytes()
}

async fn run_helper(session: &AskpassSession, prompt: &str) -> Option<String> {
    ask_over(&env_value(session, "MIXDOG_ASKPASS_ENDPOINT"), &request(&env_value(session, "MIXDOG_ASKPASS_TOKEN"), prompt)).await
}

#[test]
fn constants_match_the_desktop() {
    assert_eq!((ASKPASS_TIMEOUT_MS, RETRY_WINDOW_MS, MAX_REQUEST_BYTES), (120_000, 2_000, 65_536));
    let timings = AskpassTimings::default();
    assert_eq!((timings.timeout, timings.retry_window), (Duration::from_secs(120), Duration::from_secs(2)));
}

#[test]
fn classify_prompt_tells_a_passphrase_a_password_and_a_one_time_code_apart() {
    use AskpassKind::{Other, Otp, Passphrase, Password};
    for (prompt, kind) in [
        ("Enter passphrase for key '/home/u/.ssh/id_ed25519': ", Passphrase),
        ("root@10.0.0.1's password: ", Password),
        ("Password: ", Password),
        ("Verification code: ", Otp),
        ("Duo passcode or option (1-3): ", Otp),
        ("One-time password (OATH) for root: ", Otp),
        ("Enter PIN: ", Otp),
        ("Enter your favourite colour: ", Other),
        ("Approve the login on your phone, then press Enter: ", Other),
        ("한code: ", Otp),
    ] {
        assert_eq!(classify_prompt(prompt), kind, "{prompt}");
    }
}

#[test]
fn tokens_compare_by_content_and_length() {
    assert!(same_token(b"abc", b"abc"));
    assert!(!same_token(b"abc", b"abd"));
    assert!(!same_token(b"abc", b"abcd"));
    assert!(same_token(b"", b""));
}

#[test]
fn a_plain_path_is_printable_ascii_without_spaces() {
    assert!(is_plain_path(Path::new(r"C:\Users\jae\askpass.exe")));
    assert!(!is_plain_path(Path::new(r"C:\Users\김철수\askpass.exe")));
    assert!(!is_plain_path(Path::new(r"C:\Program Files\askpass.exe")));
    assert!(!is_plain_path(Path::new("")));
}

#[tokio::test]
async fn helper_roundtrip_presents_the_token_and_gets_the_answer() {
    let prompter = Scripted::new(|_| Some("pa ss\u{e9}w\u{f6}rd".to_owned()));
    let session = server(prompter.clone()).start(Path::new("askpass-helper")).await.unwrap();
    let prompt = "Enter passphrase for key 'C:\\Users\\김 철수\\.ssh\\id_work': ";
    assert_eq!(run_helper(&session, prompt).await.as_deref(), Some("pa ss\u{e9}w\u{f6}rd"));
    assert_eq!(prompter.questions(), [AskpassQuestion { kind: AskpassKind::Passphrase, prompt: prompt.to_owned(), retry: false }]);
    assert_eq!(env_value(&session, "SSH_ASKPASS"), "askpass-helper");
    assert!(!session.cancelled());
    let endpoint = env_value(&session, "MIXDOG_ASKPASS_ENDPOINT");
    if cfg!(windows) {
        assert!(endpoint.starts_with(r"\\.\pipe\mixdog-askpass-") && endpoint.len() == r"\\.\pipe\mixdog-askpass-".len() + 24);
        assert!(session.control_dir().is_none());
    } else {
        assert!(session.control_dir().is_some_and(|dir| endpoint.starts_with(dir.to_str().unwrap())));
    }
    session.close().await;
}

#[tokio::test]
async fn token_mismatch_refused() {
    let prompter = Scripted::new(|_| Some("secret".to_owned()));
    let session = server(prompter.clone()).start(Path::new("h")).await.unwrap();
    let endpoint = env_value(&session, "MIXDOG_ASKPASS_ENDPOINT");
    assert_eq!(ask_over(&endpoint, &request("not-the-token", "password: ")).await, None);
    assert_eq!(ask_over(&endpoint, b"not json\n").await, None);
    assert_eq!(ask_over(&endpoint, b"{\"token\":1,\"prompt\":\"p\"}\n").await, None);
    let token = env_value(&session, "MIXDOG_ASKPASS_TOKEN");
    assert_eq!(ask_over(&endpoint, format!("{{\"token\":\"{token}\"}}\n").as_bytes()).await, None);
    assert!(prompter.questions().is_empty(), "a process that does not know the token never reaches the user");
    assert_eq!(run_helper(&session, "password: ").await.as_deref(), Some("secret"));
    session.close().await;
    assert!(session.closed());
    assert_eq!(run_helper(&session, "password: ").await, None, "a closed session serves nobody");
}

#[tokio::test]
async fn a_request_over_the_cap_is_dropped_without_asking() {
    let prompter = Scripted::new(|_| Some("secret".to_owned()));
    let session = server(prompter.clone()).start(Path::new("h")).await.unwrap();
    let endpoint = env_value(&session, "MIXDOG_ASKPASS_ENDPOINT");
    let token = env_value(&session, "MIXDOG_ASKPASS_TOKEN");
    let fits = request(&token, &"p".repeat(MAX_REQUEST_BYTES - request(&token, "").len()));
    assert_eq!(fits.len(), MAX_REQUEST_BYTES);
    assert_eq!(ask_over(&endpoint, &fits).await.as_deref(), Some("secret"));
    let too_long = request(&token, &"p".repeat(MAX_REQUEST_BYTES - request(&token, "").len() + 1));
    assert_eq!(ask_over(&endpoint, &too_long).await, None);
    assert_eq!(prompter.questions().len(), 1);
    session.close().await;
}

#[tokio::test]
async fn a_cancelled_question_fails_the_helper_and_marks_the_session() {
    let session = server(Scripted::new(|_| None)).start(Path::new("h")).await.unwrap();
    assert_eq!(run_helper(&session, "password: ").await, None);
    assert!(session.cancelled());
    session.close().await;
}

#[tokio::test]
async fn a_question_that_times_out_is_dropped_and_marks_the_session_cancelled() {
    let dropped = Arc::new(AtomicBool::new(false));
    let timings = AskpassTimings { timeout: Duration::from_millis(80), retry_window: Duration::from_millis(RETRY_WINDOW_MS) };
    let session = server(Arc::new(Silent(dropped.clone()))).with_timings(timings).start(Path::new("h")).await.unwrap();
    assert_eq!(run_helper(&session, "Verification code: ").await, None);
    assert!(dropped.load(Ordering::SeqCst), "the dialog is told to close");
    assert!(session.cancelled());
    session.close().await;
}

#[tokio::test]
async fn closing_the_session_drops_a_question_in_flight() {
    let dropped = Arc::new(AtomicBool::new(false));
    let session = Arc::new(server(Arc::new(Silent(dropped.clone()))).start(Path::new("h")).await.unwrap());
    let waiting = {
        let session = session.clone();
        tokio::spawn(async move { run_helper(&session, "password: ").await })
    };
    while session.inner.turn.try_acquire().is_ok() {
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
    session.close().await;
    assert_eq!(waiting.await.unwrap(), None);
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn reuse_within_retry_window() {
    let clock = Arc::new(AtomicUsize::new(0));
    let counter = Arc::new(AtomicUsize::new(0));
    let prompter = {
        let counter = counter.clone();
        Scripted::new(move |_| Some(format!("answer-{}", counter.fetch_add(1, Ordering::SeqCst) + 1)))
    };
    let timings = AskpassTimings { timeout: Duration::from_secs(120), retry_window: Duration::from_millis(1000) };
    let session = {
        let clock = clock.clone();
        server(prompter.clone())
            .with_timings(timings)
            .with_clock(Arc::new(move || clock.load(Ordering::SeqCst) as u64))
            .start(Path::new("h"))
            .await
            .unwrap()
    };
    let set = |ms: usize| clock.store(ms, Ordering::SeqCst);
    assert_eq!(run_helper(&session, "root@h's password: ").await.as_deref(), Some("answer-1"));
    set(5000); // a later handshake of the same attempt: reused
    assert_eq!(run_helper(&session, "root@h's password: ").await.as_deref(), Some("answer-1"));
    assert_eq!(prompter.questions().len(), 1);
    set(5400); // asked again right after it was served: the server refused it
    assert_eq!(run_helper(&session, "root@h's password: ").await.as_deref(), Some("answer-2"));
    assert_eq!(prompter.questions().iter().map(|q| q.retry).collect::<Vec<_>>(), [false, true]);
    set(20_000);
    assert_eq!(run_helper(&session, "Verification code: ").await.as_deref(), Some("answer-3"));
    assert_eq!(run_helper(&session, "Verification code: ").await.as_deref(), Some("answer-4"));
    assert_eq!(prompter.questions().iter().filter(|q| q.kind == AskpassKind::Otp).count(), 2, "one-time codes are never reused");
    session.close().await;
}

#[tokio::test]
async fn concurrent_questions_are_put_to_the_user_one_after_the_other() {
    let prompter = Scripted::slow(Duration::from_millis(40));
    let session = server(prompter.clone()).start(Path::new("h")).await.unwrap();
    let (a, b, c) = tokio::join!(
        run_helper(&session, "password A: "),
        run_helper(&session, "password B: "),
        run_helper(&session, "Verification code: ")
    );
    assert!([a, b, c].iter().all(|reply| reply.as_deref() == Some("x")));
    assert_eq!(prompter.peak.load(Ordering::SeqCst), 1);
    session.close().await;
}

#[tokio::test]
async fn close_removes_the_session_folders_and_is_idempotent() {
    let session = server(Scripted::new(|_| None)).start(Path::new("h")).await.unwrap();
    if let Some(dir) = session.control_dir() {
        assert!(is_dir(&dir).await);
        assert!(dir.file_name().unwrap().to_str().unwrap().starts_with("mxa-"));
        session.close().await;
        assert!(!exists(&dir).await);
    } else {
        session.close().await;
    }
    session.close().await;
    assert!(session.closed());
}

#[tokio::test]
async fn two_sessions_have_their_own_endpoint_and_token() {
    let prompter = Scripted::new(|_| Some("x".to_owned()));
    let first = server(prompter.clone()).start(Path::new("h")).await.unwrap();
    let second = server(prompter).start(Path::new("h")).await.unwrap();
    assert_ne!(env_value(&first, "MIXDOG_ASKPASS_ENDPOINT"), env_value(&second, "MIXDOG_ASKPASS_ENDPOINT"));
    assert_ne!(env_value(&first, "MIXDOG_ASKPASS_TOKEN"), env_value(&second, "MIXDOG_ASKPASS_TOKEN"));
    assert_eq!(env_value(&first, "MIXDOG_ASKPASS_TOKEN").len(), 48);
    // One session's token opens nothing of the other's.
    let wrong = request(&env_value(&first, "MIXDOG_ASKPASS_TOKEN"), "password: ");
    assert_eq!(ask_over(&env_value(&second, "MIXDOG_ASKPASS_ENDPOINT"), &wrong).await, None);
    first.close().await;
    second.close().await;
}

#[tokio::test]
async fn a_helper_with_a_plain_path_is_used_where_it_is_and_one_without_is_copied() {
    let prompter = Scripted::new(|_| None);
    let windows = |base: Option<&Path>| {
        let server = AskpassServer::new(prompter.clone(), lane(), Platform::Windows);
        match base {
            Some(base) => server.with_plain_base(base.to_path_buf()),
            None => server,
        }
    };
    // Where a Windows-named helper would be run from: nothing is copied for a plain path, and nothing is bound here.
    let folder = tempfile::tempdir().unwrap();
    let helper = folder.path().join("askpass-helper.exe");
    write_file(&helper, b"binary").await;
    if !is_plain_path(&helper) {
        return;
    }
    let session = windows(None).start(&helper).await.unwrap();
    assert_eq!(Path::new(&env_value(&session, "SSH_ASKPASS")), helper);
    session.close().await;

    let odd_dir = folder.path().join("\u{d5cc}\u{d37c}");
    {
        let dir = odd_dir.clone();
        fs(move |lane| mixdog_fsio::create_dir(lane, dir).unwrap()).await;
    }
    let odd = odd_dir.join("askpass-helper.exe");
    write_file(&odd, b"binary").await;
    let refused = windows(None).start(&odd).await.err().unwrap();
    assert_eq!(refused.kind(), io::ErrorKind::InvalidInput);
    assert!(windows(Some(&odd_dir)).start(&odd).await.is_err(), "a base that is not plain is no help");

    let session = windows(Some(folder.path())).start(&odd).await.unwrap();
    let copy = std::path::PathBuf::from(env_value(&session, "SSH_ASKPASS"));
    assert!(is_plain_path(&copy) && copy.file_name().unwrap() == "askpass.exe" && copy.starts_with(folder.path()));
    let copied = copy.clone();
    assert_eq!(fs(move |lane| mixdog_fsio::read(lane, copied).unwrap()).await, b"binary");
    session.close().await;
    assert!(!exists(&copy).await, "the copy goes with the session");
    assert!(exists(&odd).await, "the original stays");
}
