//! `startRelay`, `finishRelayStart` and `closeRelay` of `server.mjs`: the services are built from the configuration (the feedback
//! queue, the device store, the hub of live legs, the limiters, the renderer catalog and its readiness, native push from its
//! environment, Web Push from `DATA_DIR` where no identity disables it, ICE from the TURN environment where a bad setting only logs),
//! the listener is bound, and the 10 s heartbeat and the socket diagnostics are started. A failure after the feedback queue exists closes
//! it first.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use mixdog_js::nodepath;
use mixdog_rt::{LaneTokens, TaskClass};

use super::router::Routes;
use super::upgrade::{REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, Upgrades};
use crate::config::Config;
use crate::diagnostics::{SocketDiagnostics, start_socket_diagnostics};
use crate::feedback::{FeedbackEndpoint, FeedbackOptions, FeedbackSender, FeedbackService, Mailer};
use crate::hook::{HOOK_TIMEOUT, HookHub, HookOptions, MAX_HOOK_BODY_BYTES, MAX_HOOK_PENDING_PER_DEVICE};
use crate::http1::conn::panic_message;
use crate::http1::{Handler, HandlerFuture, Limits, Request, ResponseWriter, UpgradeRequest};
use crate::ice;
use crate::ice::turn_config_from_env;
use crate::legs::hub::{Hub, HubConfig};
use crate::legs::ingress::{IngressLimits, IngressPool};
use crate::legs::phone::{PhoneLegs, PhoneLimits};
use crate::legs::policy::{
    INGRESS_FREE_WINDOW_BYTES, INGRESS_RESERVATION_BYTES, MAX_FRAME_BYTES, MAX_INFLIGHT_BYTES, MAX_INGRESS_BYTES, MAX_UPLINK_CAPACITY_BYTES,
    MAX_WS_PAYLOAD_BYTES,
};
use crate::legs::sweep::{SweepTask, start_sweep};
use crate::legs::watchdog::HandshakeTiming;
use crate::logline;
use crate::media::{MediaOptions, MediaProxy};
use crate::native_push::frames as native_frames;
use crate::native_push::{NativePush, NativePushService, PushSender};
use crate::net::{Server, bind_error_message, tls};
use crate::pages::app::AppPages;
use crate::pairing::Pairing;
use crate::rate_limit::RateLimiter;
use crate::store::DeviceStore;
use crate::web::gate::StaticGate;
use crate::web::readiness::RendererReadiness;
use crate::web::releases::RendererCatalog;
use crate::web_push::http::WebPushEndpoint;
use crate::web_push::send::{PushClient, ReqwestClient};
use crate::web_push::{WebPush, frames as web_push_frames};
use crate::ws::{ServerOptions, WebSocketServer};

/// `UNAUTHORIZED_RATE_LIMIT` and `UNAUTHORIZED_RATE_WINDOW_MS`: callers refused a credential, per address and per `auth:<address>`.
const UNAUTHORIZED_RATE_LIMIT: usize = 60;
const UNAUTHORIZED_RATE_WINDOW_MS: i64 = 60_000;

/// The options of `startRelay` beyond the configuration of the process. Production runs the defaults; the ceilings are options so they
/// can be exercised without moving 64 MiB through a test.
#[derive(Clone)]
pub struct Options {
    /// `maxFrameBytes`: the forwarding policy ceiling of one frame.
    pub max_frame_bytes: usize,
    /// `maxHookPending`.
    pub max_hook_pending: usize,
    /// `maxInflightBytes`: the box-level ceiling of outbound memory.
    pub max_inflight_bytes: usize,
    /// `maxIngressBytes`, `ingressReservationBytes` and `ingressWindowBytes`: the receive-side budget shared by every leg.
    pub max_ingress_bytes: usize,
    pub ingress_reservation_bytes: usize,
    pub ingress_window_bytes: usize,
    /// `maxPayloadBytes`: the transport ceiling of the relay's own receiver.
    pub max_payload_bytes: usize,
    /// `uplinkCapacityBytes`: an upper clamp on what a desktop leg is taken to accept.
    pub uplink_capacity_bytes: usize,
    /// `handshakeStallMs` and `livenessProbeMs`.
    pub handshake: HandshakeTiming,
    /// `feedbackEnv`, `nativePushEnv` and `turnEnv`: explicit like in Node, so only the entry that hands over the real environment turns
    /// real SMTP, push and TURN on.
    pub feedback_env: BTreeMap<String, String>,
    pub native_push_env: BTreeMap<String, String>,
    pub turn_env: BTreeMap<String, String>,
    /// `feedbackOptions`: the numbers of the feedback queue.
    pub feedback: FeedbackOptions,
}

impl Options {
    /// The defaults of the relay, with `env` as the environment of the three groups that read one.
    pub fn for_environment(env: &BTreeMap<String, String>) -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            max_hook_pending: MAX_HOOK_PENDING_PER_DEVICE,
            max_inflight_bytes: MAX_INFLIGHT_BYTES,
            max_ingress_bytes: MAX_INGRESS_BYTES,
            ingress_reservation_bytes: INGRESS_RESERVATION_BYTES,
            ingress_window_bytes: INGRESS_FREE_WINDOW_BYTES,
            max_payload_bytes: MAX_WS_PAYLOAD_BYTES,
            uplink_capacity_bytes: MAX_UPLINK_CAPACITY_BYTES,
            handshake: HandshakeTiming::default(),
            feedback_env: env.clone(),
            native_push_env: env.clone(),
            turn_env: env.clone(),
            feedback: FeedbackOptions::default(),
        }
    }
}

/// The injection points of `startRelay` (`feedbackSender`, `nativePush`, `webPushFetch`): what a test puts in place of the service the
/// relay would build.
#[derive(Default)]
pub struct Seams {
    pub feedback_sender: Option<Arc<dyn FeedbackSender>>,
    pub native_push: Option<Arc<dyn PushSender>>,
    pub web_push_client: Option<Arc<dyn PushClient>>,
}

/// `server.on('request')` and `server.on('upgrade')`.
struct Front {
    routes: Arc<Routes>,
    upgrades: Arc<Upgrades>,
}

impl Handler for Front {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        let routes = Arc::clone(&self.routes);
        Box::pin(async move { routes.route(request, response).await })
    }

    /// The upgrade listener runs outside any request scope, so a throw here would be an uncaught exception for the whole fleet: it is
    /// answered with a dead socket instead.
    fn upgrade(&self, upgrade: UpgradeRequest) {
        let upgrades = Arc::clone(&self.upgrades);
        drop(mixdog_rt::spawn("relay-upgrade", TaskClass::Control, async move {
            let outcome = futures::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(upgrades.serve(upgrade))).await;
            if let Err(payload) = outcome {
                logline::emit(&logline::websocket_upgrade_failed(&panic_message(payload.as_ref())));
            }
        }));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What `close` takes down, once.
struct Running {
    sweep: SweepTask,
    diagnostics: SocketDiagnostics,
    server: Server,
    sockets: Arc<WebSocketServer>,
    hub: Arc<Hub>,
    hooks: Arc<HookHub>,
    feedback: Arc<FeedbackEndpoint>,
}

impl Running {
    /// `closeRelay`.
    async fn close(self) {
        self.sweep.stop();
        self.diagnostics.stop();
        // Stop timers and let any in-flight send settle before the process exits.
        close_feedback(&self.feedback).await;
        // The live desktops and the phones attached to them, then the hook legs and the requests parked on them.
        self.hub.shutdown();
        for leg in self.hooks.legs() {
            leg.socket().terminate();
        }
        self.hooks.fail_pending_and_clear();
        // Flush any debounced device registration before the process goes away.
        self.hub.store().save_or_log().await;
        self.sockets.close().await;
        self.server.close().await;
    }
}

/// A relay that is listening.
pub struct RunningRelay {
    /// The port the listener is bound to (the one the system chose for `PORT=0`).
    pub port: u16,
    store: DeviceStore,
    running: Mutex<Option<Running>>,
}

impl RunningRelay {
    /// The device store of the relay (`relay.store`).
    pub fn store(&self) -> &DeviceStore {
        &self.store
    }

    /// `close()`: stops the heartbeat and the diagnostics, awaits the feedback queue, terminates every leg, fails the pending hook
    /// requests, saves the store and closes the listener. Closing twice does nothing the second time.
    pub async fn close(&self) {
        let running = lock(&self.running).take();
        if let Some(running) = running {
            running.close().await;
        }
    }
}

async fn close_feedback(feedback: &FeedbackEndpoint) {
    if let Some(service) = feedback.service() {
        service.close().await;
    }
}

/// `startRelay` and `finishRelayStart`. The executors of mixdog-rt must be installed; `tokens` are the lane tokens they minted.
/// The error is the text the entry prints after `[relay] failed to start:`.
pub async fn start(config: &Config, options: Options, seams: Seams, tokens: LaneTokens) -> Result<RunningRelay, String> {
    let data_dir = PathBuf::from(nodepath::resolve_host(&[config.data_dir.as_str()]));
    let mailer = Mailer::from_env(&options.feedback_env);
    let feedback_options = match &mailer {
        Some(mailer) => mailer.options(options.feedback.clone()),
        None => options.feedback.clone(),
    };
    let sender = seams.feedback_sender.clone().or_else(|| mailer.map(|mailer| Arc::new(mailer) as Arc<dyn FeedbackSender>));
    let service = FeedbackService::start(&data_dir, tokens.durability_io, sender, feedback_options).await;
    let feedback = Arc::new(FeedbackEndpoint::new(Some(service)));
    match assemble(config, &options, seams, tokens, &data_dir, &feedback).await {
        Ok(relay) => Ok(relay),
        Err(message) => {
            close_feedback(&feedback).await;
            Err(message)
        }
    }
}

/// `createRelayIce`: TURN credential issuance, or nothing when the deploy has not provisioned coturn or its settings are unusable. A bad
/// TURN setting must not take the relay down: desktops simply see no `ice` capability.
fn register_ice(hub: &Hub, env: &BTreeMap<String, String>) -> Result<(), String> {
    match turn_config_from_env(env) {
        Ok(Some(turn)) => ice::frames::register(hub.dispatch(), turn).map_err(|error| error.to_string()),
        Ok(None) => Ok(()),
        Err(error) => {
            logline::emit(&logline::turn_issuance_disabled(&error.to_string()));
            Ok(())
        }
    }
}

/// `createRelayWebPush`: the relay-owned identity and registry, or `None` when no identity could be loaded or minted (desktops then keep
/// their own direct send).
fn open_web_push(data_dir: &Path, client: Option<Arc<dyn PushClient>>) -> Result<Option<Arc<WebPush>>, String> {
    let client: Arc<dyn PushClient> = match client {
        Some(client) => client,
        None => Arc::new(ReqwestClient::new()?),
    };
    Ok(WebPush::open(data_dir, client).map(Arc::new))
}

fn ingress_limits(options: &Options) -> IngressLimits {
    IngressLimits {
        ceiling: options.max_ingress_bytes,
        reservation: options.ingress_reservation_bytes,
        window: options.ingress_window_bytes,
        limit: options.max_frame_bytes,
        transport: options.max_payload_bytes,
    }
}

async fn assemble(
    config: &Config,
    options: &Options,
    seams: Seams,
    tokens: LaneTokens,
    data_dir: &Path,
    feedback: &Arc<FeedbackEndpoint>,
) -> Result<RunningRelay, String> {
    let store = DeviceStore::open(data_dir, tokens.durability_io).await.map_err(|error| error.0)?;
    let pool = IngressPool::new();
    let ingress = ingress_limits(options);
    let hub = Hub::new(
        store.clone(),
        HubConfig {
            max_frame_bytes: options.max_frame_bytes,
            uplink_capacity_ceiling: options.uplink_capacity_bytes,
            max_inflight_bytes: options.max_inflight_bytes,
            handshake: options.handshake,
            ingress,
        },
        pool.clone(),
    );
    let hooks = HookHub::new(
        pool,
        HookOptions { max_pending: options.max_hook_pending, timeout: HOOK_TIMEOUT, ingress: IngressLimits { limit: MAX_HOOK_BODY_BYTES, ..ingress } },
    );
    let unauthorized = Arc::new(Mutex::new(RateLimiter::new(UNAUTHORIZED_RATE_LIMIT, UNAUTHORIZED_RATE_WINDOW_MS)));

    // Native push is sent per device; tokens are bound to the device and the paired client that registered them. A sender that can
    // deliver to no platform is no sender: desktops then see no native push capability.
    let push: Arc<dyn PushSender> = match seams.native_push {
        Some(push) => push,
        None => Arc::new(NativePush::from_environment(&options.native_push_env)),
    };
    let native = Arc::new(NativePushService::new((!push.platforms().is_empty()).then_some(push)));
    native_frames::register(hub.dispatch(), &native).map_err(|error| error.to_string())?;
    let web_push = open_web_push(data_dir, seams.web_push_client)?;
    if let Some(web_push) = &web_push {
        web_push_frames::register(&hub, Arc::clone(web_push)).map_err(|error| error.to_string())?;
    }
    register_ice(&hub, &options.turn_env)?;
    let pairing = Pairing::new(Arc::clone(&hub), Arc::clone(&unauthorized));
    pairing.register().map_err(|error| error.to_string())?;
    let media = MediaProxy::start(Arc::clone(&hub), Arc::clone(&unauthorized), MediaOptions::default()).map_err(|error| error.to_string())?;

    // HTTP/1.1: an h2 listener negotiated fine in isolation but killed phone legs in live traffic, so the listener stays on the transport
    // where the legs are known to survive (see `net::tls`).
    let tls = if config.scheme() == "https" { Some(tls::load(&config.tls_cert, &config.tls_key)?) } else { None };
    let sockets = Arc::new(WebSocketServer::new(ServerOptions::new(options.max_payload_bytes as u64)));
    let phone = PhoneLegs::new(Arc::clone(&hub), Arc::clone(&sockets), Arc::clone(&unauthorized), PhoneLimits::default());

    let (renderer_dir, releases_dir) = (PathBuf::from(&config.renderer_dir), PathBuf::from(&config.renderer_releases_dir));
    let routes = Routes {
        readiness: RendererReadiness::new(renderer_dir.clone(), releases_dir.clone()),
        feedback: Arc::clone(feedback),
        hooks: Arc::clone(&hooks),
        pairing,
        app: AppPages::load(&config.install_dir),
        web_push: WebPushEndpoint::new(web_push, Arc::clone(&hub), Arc::clone(&unauthorized)),
        media,
        gate: StaticGate::new(
            tokens.interactive_io,
            Arc::new(RendererCatalog::new(renderer_dir, releases_dir)),
            Arc::new(store.clone()),
            Arc::clone(&unauthorized),
        ),
    };
    let upgrades = Upgrades {
        hub: Arc::clone(&hub),
        hooks: Arc::clone(&hooks),
        sockets: Arc::clone(&sockets),
        phone,
        register_limiter: Mutex::new(RateLimiter::new(REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS)),
        unauthorized,
    };
    let front = Front { routes: Arc::new(routes), upgrades: Arc::new(upgrades) };

    let port = config.listen_port()?;
    let server = Server::start(port, tls, Arc::new(front), Limits::default()).await.map_err(|error| bind_error_message(&error, port))?;
    let sweep = start_sweep(Arc::clone(&hub), Some(Arc::clone(&hooks)));
    let diagnostics = start_socket_diagnostics({
        let hub = Arc::clone(&hub);
        Arc::new(move || hub.snapshot())
    });
    Ok(RunningRelay {
        port: server.port(),
        store,
        running: Mutex::new(Some(Running { sweep, diagnostics, server, sockets, hub, hooks, feedback: Arc::clone(feedback) })),
    })
}
