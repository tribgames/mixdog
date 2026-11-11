//! The one shared render browser (D-L2). Workers that lay HTML out ask for its DevTools endpoint;
//! the first request launches a headless Chromium, later requests reuse it, and a browser that
//! exited is launched again by the next request. Launches are serialized by construction: one
//! actor task answers requests in order, so concurrent first requests share one launch.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_rt::LaneToken;
use mixdog_rt::SpawnIo;
use mixdog_rt::TaskClass;
use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::ChildStderr;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::exits::ChildExits;
use crate::owner;
use crate::owner::Kill;
use crate::process::Proc;
use crate::process::ProcOps;
use crate::process::spawn_command;

const ENDPOINT_PREFIX: &str = "DevTools listening on ";

/// How the render browser is found and kept.
#[derive(Clone, Debug)]
pub struct RenderBrowserConfig {
    /// Program and leading arguments of the browser. `None` looks for Chrome, Chromium or Edge in
    /// their usual install locations (`PUPPETEER_EXECUTABLE_PATH` first).
    pub command: Option<(PathBuf, Vec<OsString>)>,
    /// Parent of the browser's throwaway profile directories.
    pub profile_root: PathBuf,
    /// Adds `--no-sandbox` (containers and CI).
    pub no_sandbox: bool,
}

#[derive(Clone)]
pub(crate) struct BrowserHandle {
    requests: mpsc::UnboundedSender<Request>,
}

impl BrowserHandle {
    /// Ends the render browser, if one runs, and returns once its owner has signalled and reaped
    /// it. Later endpoint requests are refused.
    pub(crate) async fn shutdown(&self) {
        let (done, finished) = oneshot::channel();
        if self.requests.send(Request::Shutdown(done)).is_ok() {
            let _ = finished.await;
        }
    }

    /// The DevTools WebSocket endpoint of the running render browser, launching it if needed. This
    /// does not restart the idle clock; only a launch or the release of the last lease does.
    pub(crate) async fn endpoint(&self) -> Result<String, BrowserError> {
        self.ask(false).await.map(|(ws, _)| ws)
    }

    /// Like [`endpoint`](Self::endpoint), and the browser is kept open for as long as the lease
    /// lives (a call that holds a CDP connection for longer than the idle period).
    pub(crate) async fn lease(&self) -> Result<(String, BrowserLease), BrowserError> {
        let (ws, lease) = self.ask(true).await?;
        Ok((ws, lease.expect("a lease was asked for")))
    }

    async fn ask(&self, lease: bool) -> Result<(String, Option<BrowserLease>), BrowserError> {
        let (reply, answer) = oneshot::channel();
        self.requests
            .send(Request::Endpoint(Waiter { reply, lease }))
            .map_err(|_| BrowserError::Stopped)?;
        let ws = answer.await.map_err(|_| BrowserError::Stopped)??;
        let lease = lease.then(|| BrowserLease {
            requests: self.requests.clone(),
        });
        Ok((ws, lease))
    }
}

/// The shared render browser as other crates see it. Cloneable; every clone asks the one service.
/// Launch, idle close and the guarding of the browser's process tree stay in this crate.
#[derive(Clone)]
pub struct RenderBrowser(pub(crate) BrowserHandle);

impl RenderBrowser {
    /// The DevTools WebSocket URL of the running browser, launching it when none is. A call
    /// does not restart the browser's idle clock (60 s by default, `PUPPETEER_POOL_IDLE_MS`), as
    /// in Node's pool, which restarts it only on release: a user whose work is shorter than the
    /// period since the launch or the last release needs nothing more.
    ///
    /// # Errors
    /// The launch failed or the host is closing; the text is the one the workers' callers see.
    pub async fn endpoint(&self) -> Result<String, String> {
        self.0.endpoint().await.map_err(|error| error.to_string())
    }
}

#[async_trait::async_trait]
impl mixdog_core_api::domain::ext::BrowserEndpoint for RenderBrowser {
    async fn lease(&self) -> Result<(String, mixdog_core_api::domain::ext::BrowserHold), String> {
        let (ws, lease) = self.0.lease().await.map_err(|error| error.to_string())?;
        Ok((ws, Box::new(lease)))
    }
}

/// Keeps the render browser from closing for idleness while it lives.
pub(crate) struct BrowserLease {
    requests: mpsc::UnboundedSender<Request>,
}

impl Drop for BrowserLease {
    fn drop(&mut self) {
        let _ = self.requests.send(Request::Release);
    }
}

/// The idle period after which an unused browser is closed: `PUPPETEER_POOL_IDLE_MS` through
/// `idle_period_from`, as the web renderer's pool does (`web-tools.mjs:55`).
fn idle_period() -> Duration {
    idle_period_from(std::env::var("PUPPETEER_POOL_IDLE_MS").ok().as_deref())
}

/// `Math.max(5_000, Number(env) || 60_000)` handed to `setTimeout` (`web-tools.mjs:55`, `:112`):
/// an unset, empty, zero or non-numeric value is 60 s, and a delay outside 1..=2^31-1 ms (only
/// reachable above it) becomes 1 ms, as Node's timers do; a fraction is truncated.
fn idle_period_from(env: Option<&str>) -> Duration {
    let number = env.map_or(f64::NAN, mixdog_js::string_to_number);
    let requested = if number.is_nan() || number == 0.0 { 60_000.0 } else { number };
    let millis = mixdog_js::math::max(5_000.0, requested);
    let millis = if (1.0..=2_147_483_647.0).contains(&millis) { millis.trunc() } else { 1.0 };
    Duration::from_millis(millis as u64)
}

/// `launches` counts every browser launch, so the owner can observe reuse.
pub(crate) fn start(
    config: RenderBrowserConfig,
    spawn_io: SpawnIo,
    rt: Handle,
    launches: Arc<AtomicU64>,
    exits: ChildExits,
) -> BrowserHandle {
    start_with_idle(config, spawn_io, rt, launches, exits, idle_period())
}

pub(crate) fn start_with_idle(
    config: RenderBrowserConfig,
    spawn_io: SpawnIo,
    rt: Handle,
    launches: Arc<AtomicU64>,
    exits: ChildExits,
    idle: Duration,
) -> BrowserHandle {
    let (requests, inbox) = mpsc::unbounded_channel::<Request>();
    let launcher = Launcher {
        config,
        spawn_io,
        rt,
        launches,
        exits,
    };
    mixdog_rt::spawn("exthost.browser", TaskClass::Work, serve(launcher, inbox, idle));
    BrowserHandle { requests }
}

/// Why no endpoint could be given.
#[derive(Clone, Debug)]
pub(crate) enum BrowserError {
    /// The service was shut down (or is gone) before a browser could answer.
    Stopped,
    /// The browser could not be started or exited before it published its endpoint.
    Launch(String),
}

impl std::fmt::Display for BrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stopped => f.write_str("render browser service stopped"),
            Self::Launch(why) => f.write_str(why),
        }
    }
}

/// Someone waiting for the endpoint; `lease` says the browser must be kept while they hold one.
struct Waiter {
    reply: oneshot::Sender<Result<String, BrowserError>>,
    lease: bool,
}

impl Waiter {
    /// Answers; a granted lease is counted, and not counted when the asker is already gone.
    fn answer(self, result: Result<String, BrowserError>, leases: &mut usize) {
        let granted = self.lease && result.is_ok();
        if self.reply.send(result).is_ok() && granted {
            *leases += 1;
        }
    }
}

enum Request {
    Endpoint(Waiter),
    /// A [`BrowserLease`] was dropped.
    Release,
    Shutdown(oneshot::Sender<()>),
}

/// A launch in progress, as its own task: the service loop never awaits it inline, so a shutdown
/// is always seen. `cancel` ends it (killing a browser that lives but has not published its
/// endpoint) and the task answers only after that browser's owner has signalled and reaped it.
struct Launching {
    outcome: oneshot::Receiver<Result<Running, BrowserError>>,
    cancel: CancellationToken,
    waiters: Vec<Waiter>,
}

impl Launching {
    /// Cancels the launch, waits until its browser (if any) is gone, and tells the waiters.
    async fn cancel_and_wait(mut self) {
        self.cancel.cancel();
        // The launch may have won the race just before the cancel: that browser is stopped too.
        if let Ok(Ok(running)) = (&mut self.outcome).await {
            running.stop().await;
        }
        let mut none = 0;
        for waiter in self.waiters {
            waiter.answer(Err(BrowserError::Stopped), &mut none);
        }
    }
}

/// The service: answers endpoint requests from the running browser, runs at most one launch at a
/// time (concurrent requests share it), and on shutdown ends whatever exists, launching or running.
///
/// A browser nobody holds a lease on, and nobody has asked about for `idle`, is closed through its
/// owner; the next request launches a new one.
async fn serve(launcher: Launcher, mut inbox: mpsc::UnboundedReceiver<Request>, idle: Duration) {
    let mut running: Option<Running> = None;
    let mut launching: Option<Launching> = None;
    let mut closed = false;
    let mut leases = 0usize;
    // Node's pool timer (`web-tools.mjs:93-114`): armed when the browser has no user left (the
    // last lease released, or a launch finished with none), cleared while a lease is held, and
    // left alone by an endpoint request on a browser that is already running.
    let mut idle_at: Option<tokio::time::Instant> = None;
    loop {
        if running.is_none() || leases > 0 {
            idle_at = None;
        } else if idle_at.is_none() {
            idle_at = Some(tokio::time::Instant::now() + idle);
        }
        // Biased: an expired idle timer is taken before a request that is already queued, so what
        // happens at one instant does not depend on a random branch order.
        tokio::select! {
            biased;
            () = async {
                match idle_at {
                    Some(at) => mixdog_rt::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => {
                if let Some(browser) = running.take() {
                    browser.stop().await;
                }
            }
            request = inbox.recv() => match request {
                None => break,
                Some(Request::Release) => leases = leases.saturating_sub(1),
                Some(Request::Endpoint(waiter)) => {
                    if closed {
                        waiter.answer(Err(BrowserError::Stopped), &mut leases);
                        continue;
                    }
                    if let Some(browser) = &running
                        && browser.alive.load(Ordering::Acquire)
                    {
                        let ws = browser.ws.clone();
                        waiter.answer(Ok(ws), &mut leases);
                        continue;
                    }
                    running = None;
                    match &mut launching {
                        Some(launch) => launch.waiters.push(waiter),
                        None => launching = Some(launcher.begin(waiter)),
                    }
                }
                Some(Request::Shutdown(done)) => {
                    closed = true;
                    if let Some(launch) = launching.take() {
                        launch.cancel_and_wait().await;
                    }
                    if let Some(browser) = running.take() {
                        browser.stop().await;
                    }
                    let _ = done.send(());
                }
            },
            outcome = async {
                match launching.as_mut() {
                    Some(launch) => (&mut launch.outcome).await,
                    None => std::future::pending().await,
                }
            } => {
                let launch = launching.take().expect("a launch was pending");
                let answer = match outcome {
                    Ok(Ok(browser)) => {
                        let ws = browser.ws.clone();
                        running = Some(browser);
                        Ok(ws)
                    }
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err(BrowserError::Launch("render browser launch task ended".to_owned())),
                };
                for waiter in launch.waiters {
                    waiter.answer(answer.clone(), &mut leases);
                }
            }
        }
    }
    // Every handle is gone without a shutdown: a pending launch is cancelled, and dropping
    // `running` asks its owner to end the browser.
    if let Some(launch) = launching.take() {
        launch.cancel.cancel();
    }
}

struct Running {
    ws: String,
    alive: Arc<AtomicBool>,
    /// Asks the browser's owner task to end it; only that task signals or reaps.
    kill: Kill,
    /// Resolves (its sender is dropped) once the owner has signalled and reaped the browser.
    gone: oneshot::Receiver<()>,
}

impl Running {
    /// Ends the browser and waits until its owner has signalled the group and reaped it.
    async fn stop(mut self) {
        self.kill.kill();
        let _ = (&mut self.gone).await;
    }
}

/// Dropping the service (every worker is gone) ends the browser and its helpers.
impl Drop for Running {
    fn drop(&mut self) {
        self.kill.kill();
    }
}

#[derive(Clone)]
struct Launcher {
    config: RenderBrowserConfig,
    spawn_io: SpawnIo,
    rt: Handle,
    launches: Arc<AtomicU64>,
    exits: ChildExits,
}

impl Launcher {
    /// Starts a launch as its own task; `first` waits for its endpoint.
    fn begin(&self, first: Waiter) -> Launching {
        let (done, outcome) = oneshot::channel();
        let cancel = CancellationToken::new();
        let launcher = self.clone();
        let token = cancel.clone();
        mixdog_rt::spawn("exthost.browser.launch", TaskClass::Work, async move {
            let _ = done.send(launcher.launch(&token).await);
        });
        Launching {
            outcome,
            cancel,
            waiters: vec![first],
        }
    }

    /// Spawns the browser under its owner and waits for the endpoint it publishes. Cancelling
    /// `cancel` while it waits ends the browser through its owner and returns once that owner has
    /// signalled and reaped it.
    async fn launch(&self, cancel: &CancellationToken) -> Result<Running, BrowserError> {
        let launch = self.launches.fetch_add(1, Ordering::Relaxed);
        let config = self.config.clone();
        let rt = self.rt.clone();
        let spawned = self
            .spawn_io
            .submit(&CancellationToken::new(), move |_lane| {
                spawn_browser(&config, launch, &rt)
            })
            .map_err(|full| BrowserError::Launch(full.to_string()))?
            .await
            .map_err(|dropped| BrowserError::Launch(dropped.to_string()))?
            .map_err(BrowserError::Launch)?;
        let (mut proc, profile) = spawned;
        let stderr = proc.child.stderr.take();
        // Waiting on a tokio child closes its stdin; the browser keeps its stdin open for as long
        // as it runs, so the owner task holds it.
        let stdin = proc.child.stdin.take();
        let alive = Arc::new(AtomicBool::new(true));
        let (ws_tx, ws_rx) = oneshot::channel();
        let (gone_tx, gone) = oneshot::channel::<()>();
        let alive_flag = alive.clone();
        let cleanup = self.spawn_io;
        // The browser exists from here on, and its owner from this line: nothing below can leave
        // it without the owner signalling and reaping it.
        let (mut owner, kill) = owner::owner(ProcOps::new(proc, self.exits.clone()));
        // One task owns the browser from launch to exit: it forwards the endpoint once the
        // browser prints it, keeps draining stderr, signals its group and reaps it when it ends,
        // and removes the profile afterwards.
        mixdog_rt::spawn("exthost.browser.watch", TaskClass::Work, async move {
            let watch = async move {
                match stderr {
                    Some(stderr) => watch_stderr(stderr, ws_tx).await,
                    // Without stderr no endpoint can arrive; dropping `ws_tx` says so.
                    None => drop(ws_tx),
                }
            };
            tokio::pin!(watch);
            let exit = owner.until_exit();
            tokio::pin!(exit);
            let mut watching = true;
            loop {
                tokio::select! {
                    () = &mut watch, if watching => watching = false,
                    _ = &mut exit => break,
                }
            }
            drop(stdin);
            alive_flag.store(false, Ordering::Release);
            // The owner has signalled and reaped: whoever waits on `gone` may proceed.
            drop(gone_tx);
            let _ = cleanup.submit(&CancellationToken::new(), move |_lane| {
                #[allow(clippy::disallowed_methods, reason = "runs as a spawn-io lane job")]
                let _ = std::fs::remove_dir_all(profile);
            });
        });
        // No `?` between here and the end: every outcome that does not keep the browser takes the
        // one path below, which asks the owner to end it and waits until it has reaped it.
        let endpoint = tokio::select! {
            ws = ws_rx => ws.map_err(|_| {
                BrowserError::Launch("render browser did not publish its DevTools endpoint".to_owned())
            }),
            () = cancel.cancelled() => Err(BrowserError::Stopped),
        };
        match endpoint {
            Ok(ws) => Ok(Running {
                ws,
                alive,
                kill,
                gone,
            }),
            Err(error) => {
                kill.kill();
                let _ = gone.await;
                Err(error)
            }
        }
    }
}

/// Drains stderr to EOF, handing the first DevTools endpoint line to `ws_tx`.
async fn watch_stderr(stderr: ChildStderr, ws_tx: oneshot::Sender<String>) {
    let mut lines = BufReader::new(stderr);
    let mut ws_tx = Some(ws_tx);
    let mut line = Vec::new();
    loop {
        line.clear();
        match lines.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                if let Some(rest) = text.trim_end().strip_prefix(ENDPOINT_PREFIX)
                    && let Some(tx) = ws_tx.take()
                {
                    let _ = tx.send(rest.to_owned());
                }
            }
        }
    }
}

type Spawned = (Proc, PathBuf);

#[allow(clippy::disallowed_methods, reason = "called only from a spawn-io lane job")]
fn spawn_browser(config: &RenderBrowserConfig, launch: u64, rt: &Handle) -> Result<Spawned, String> {
    let (program, mut args) = match &config.command {
        Some((program, leading)) => (program.clone(), leading.clone()),
        None => (find_browser().ok_or("no Chrome, Chromium or Edge found")?, Vec::new()),
    };
    let profile = config
        .profile_root
        .join(format!("render-browser-{}-{launch}", std::process::id()));
    std::fs::create_dir_all(&profile).map_err(|e| format!("render browser profile: {e}"))?;
    args.extend(browser_args(&profile, config.no_sandbox));
    let proc = spawn_command(&program, &args, &[], rt).map_err(|e| {
        let _ = std::fs::remove_dir_all(&profile);
        format!("render browser launch failed: {e}")
    })?;
    Ok((proc, profile))
}

fn browser_args(profile: &std::path::Path, no_sandbox: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-extensions",
        "--disable-sync",
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        "--hide-scrollbars",
        "--mute-audio",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    let mut user_data = OsString::from("--user-data-dir=");
    user_data.push(profile);
    args.push(user_data);
    if no_sandbox {
        args.push("--no-sandbox".into());
    }
    args
}

#[allow(clippy::disallowed_methods, reason = "called only from a spawn-io lane job")]
fn find_browser() ->Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PUPPETEER_EXECUTABLE_PATH") {
        let explicit = PathBuf::from(explicit);
        if explicit.exists() {
            return Some(explicit);
        }
    }
    install_locations().into_iter().find(|path| path.exists())
}

#[cfg(windows)]
fn install_locations() -> Vec<PathBuf> {
    let env = |name: &str, default: &str| PathBuf::from(std::env::var_os(name).unwrap_or_else(|| default.into()));
    let program_files = env("PROGRAMFILES", "C:/Program Files");
    let program_files_x86 = env("PROGRAMFILES(X86)", "C:/Program Files (x86)");
    let mut found = vec![
        program_files.join("Google/Chrome/Application/chrome.exe"),
        program_files_x86.join("Google/Chrome/Application/chrome.exe"),
    ];
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    found.extend(local.iter().map(|d| d.join("Google/Chrome/Application/chrome.exe")));
    found.push(program_files.join("Microsoft/Edge/Application/msedge.exe"));
    found.push(program_files_x86.join("Microsoft/Edge/Application/msedge.exe"));
    found.extend(local.iter().map(|d| d.join("Microsoft/Edge/Application/msedge.exe")));
    found
}

#[cfg(target_os = "macos")]
fn install_locations() -> Vec<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    .map(PathBuf::from)
    .to_vec()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn install_locations() -> Vec<PathBuf> {
    [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/usr/bin/microsoft-edge",
    ]
    .map(PathBuf::from)
    .to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDLE: Duration = Duration::from_millis(300);

    fn service(launches: &Arc<AtomicU64>) -> BrowserHandle {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
        let config = RenderBrowserConfig {
            command: Some((
                "node".into(),
                vec![root.join("src/ext-host/test/fake-browser.mjs").into_os_string()],
            )),
            profile_root: std::env::temp_dir().join("mixdog-exthost-idle-tests"),
            no_sandbox: false,
        };
        start_with_idle(
            config,
            mixdog_rt::testing::tokens().spawn_io,
            Handle::current(),
            launches.clone(),
            ChildExits::watch().unwrap(),
            IDLE,
        )
    }

    #[test]
    fn the_idle_period_is_nodes_math_max_of_the_environment_value() {
        let ms = |env| idle_period_from(env).as_millis();
        assert_eq!(ms(None), 60_000);
        assert_eq!(ms(Some("")), 60_000);
        assert_eq!(ms(Some("0")), 60_000);
        assert_eq!(ms(Some("abc")), 60_000);
        assert_eq!(ms(Some("100")), 5_000, "at least 5 s");
        assert_eq!(ms(Some("-3")), 5_000, "a negative number is a number: the floor applies");
        assert_eq!(ms(Some(" 7500.9 ")), 7_500);
        assert_eq!(ms(Some("1e4")), 10_000);
        assert_eq!(ms(Some("0x1F40")), 8_000);
        assert_eq!(ms(Some("2147483647")), 2_147_483_647);
        assert_eq!(ms(Some("2147483648")), 1, "setTimeout overflow becomes 1 ms");
        assert_eq!(ms(Some("Infinity")), 1);
    }

    // The idle timer runs on the paused tokio clock: time moves only through `advance`, so no
    // assertion depends on how fast the machine is. The service takes an expired idle timer before
    // any request already queued (its `select!` is biased), so a request sent after an `advance`
    // past the period always meets the closed browser.

    /// Moves the clock past the idle period and lets the service take its expired timer.
    async fn pass_idle_period() {
        tokio::time::advance(IDLE + Duration::from_millis(1)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_unused_browser_closes_after_the_idle_period_and_the_next_request_launches_again() {
        let launches = Arc::new(AtomicU64::new(0));
        let browser = service(&launches);
        let first = browser.endpoint().await.unwrap();
        assert_eq!(browser.endpoint().await.unwrap(), first, "in use: one browser");
        assert_eq!(launches.load(Ordering::Relaxed), 1);

        // Just short of the period since the launch: still the same browser.
        tokio::time::advance(IDLE - Duration::from_millis(1)).await;
        assert_eq!(browser.endpoint().await.unwrap(), first, "not yet idle");
        assert_eq!(launches.load(Ordering::Relaxed), 1);

        pass_idle_period().await;
        let second = browser.endpoint().await.unwrap();
        assert_ne!(second, first, "the idle browser was closed and a new one launched");
        assert_eq!(launches.load(Ordering::Relaxed), 2);
        browser.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_endpoint_request_does_not_restart_the_idle_clock_without_a_lease() {
        let launches = Arc::new(AtomicU64::new(0));
        let browser = service(&launches);
        let first = browser.endpoint().await.unwrap();

        // A request just short of the period is served by the same browser ...
        tokio::time::advance(IDLE - Duration::from_millis(100)).await;
        assert_eq!(browser.endpoint().await.unwrap(), first);
        // ... and did not push the expiry: the period counted from the launch ends here.
        tokio::time::advance(Duration::from_millis(101)).await;
        assert_ne!(browser.endpoint().await.unwrap(), first, "closed on the launch's clock");
        assert_eq!(launches.load(Ordering::Relaxed), 2);
        browser.shutdown().await;
    }

    /// The trait the web renderer holds gives the browser only together with its hold.
    #[tokio::test(start_paused = true)]
    async fn the_endpoint_trait_keeps_the_browser_open_until_its_hold_is_dropped() {
        use mixdog_core_api::domain::ext::BrowserEndpoint;

        let launches = Arc::new(AtomicU64::new(0));
        let render = RenderBrowser(service(&launches));
        let (first, hold) = BrowserEndpoint::lease(&render).await.unwrap();
        for _ in 0..4 {
            pass_idle_period().await;
        }
        assert_eq!(render.endpoint().await.unwrap(), first, "held for a long render: still open");
        assert_eq!(launches.load(Ordering::Relaxed), 1);

        drop(hold);
        assert_eq!(render.endpoint().await.unwrap(), first, "released, not yet idle");
        pass_idle_period().await;
        assert_ne!(render.endpoint().await.unwrap(), first, "closed after the period from the release");
        render.0.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_lease_keeps_the_browser_open_and_its_release_starts_the_idle_clock() {
        let launches = Arc::new(AtomicU64::new(0));
        let browser = service(&launches);
        let (first, lease) = browser.lease().await.unwrap();

        for _ in 0..4 {
            pass_idle_period().await;
        }
        // The answer to this request also proves the service saw no idle expiry while held.
        assert_eq!(browser.endpoint().await.unwrap(), first, "held: never closed for idleness");
        assert_eq!(launches.load(Ordering::Relaxed), 1);

        // The release is queued before this request, so the service has processed it (and armed
        // the idle clock) by the time the request is answered.
        drop(lease);
        assert_eq!(browser.endpoint().await.unwrap(), first, "released but not yet idle");
        pass_idle_period().await;
        assert_ne!(browser.endpoint().await.unwrap(), first, "released: closed after the idle period");
        assert_eq!(launches.load(Ordering::Relaxed), 2);
        browser.shutdown().await;
    }
}
