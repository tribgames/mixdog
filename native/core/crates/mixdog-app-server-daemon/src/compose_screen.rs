//! The composition of the phone's whole-PC screen control: the sources (`ScreenSources` of mixdog-tools) over the ports this core
//! has, so that a paired phone's screen sessions run in the core.
//!
//! - displays: the monitors the desktop enumerates (`host/computer/displays`, `HostDisplays`) and their pictures
//!   (`host/computer/pixels`, [`HostPixels`], the JPEG the desktop uploaded to the core's blob store);
//! - access: a paired connection's grant before its screen `ready` is forwarded (the displays are listed by then), and its withdrawal
//!   when the connection or its pairing ends ([`PhoneScreens`], called by the live view);
//! - the viewer: the live view resolves a phone's screen signal to its session, takes the track's pictures from the display (or the
//!   helper's drawn frames) and carries the screen channel's messages (`live`);
//! - input: one `mixdog-computer --screen-input` process per session ([`InputHost`] over `ScreenInput`);
//! - the pill: the on-PC indicator of the desktop, driven by `host/screen/indicator` and stopped by `host/screen/indicator/stop`
//!   ([`DesktopIndicator`], [`IndicatorStops`]);
//! - the phone's Windows password: PC access's `approve_with_credential` ([`CorePcAccess`]) and the administrator check;
//! - display changes: the desktop's `host/screen/displaysChanged` re-reads the monitors and renews every session's geometry;
//! - quit: [`Screens::stop_step`] stops every session under the quit budget (their input is released) before the live view goes.
//!
//! Windows only: elsewhere the phone's screen control reports once, at error level, that it is off.
//!
//! `compose_flip.rs` calls [`installer`] where PC access is built and [`compose_screen`] once, where PC access, the computer pool and the
//! live view exist.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core::run_host::native_tools::NativeToolPaths;
use mixdog_core_api::HostChannel;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_domains::domains::host::ScreenEvents;
use mixdog_core_domains::domains::pc_access::PcAccessInstaller;
use mixdog_core_domains::domains::pc_access::PcAccessService;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_tools::desktop::computer_pixels::ComputerBlobs;

use crate::compose_flip::StopStep;
use crate::live_view::PhoneScreens;

/// The secure-desktop helper of the production installer, which the phone's screen control installs through as PC access does (one
/// admin action at a time across both).
#[cfg(windows)]
pub type PcHelper = Arc<mixdog_tools::desktop::pc_access_helper::PcAccessHelper>;
#[cfg(not(windows))]
pub type PcHelper = ();

/// The installer of PC access over the bridge executable at `exe`, with the helper it drives.
#[cfg(windows)]
pub fn installer(exe: PathBuf) -> (Arc<dyn PcAccessInstaller>, PcHelper) {
    mixdog_core_domains::domains::pc_access_installer::production_installer_with_helper(exe)
}

#[cfg(not(windows))]
pub fn installer(exe: PathBuf) -> (Arc<dyn PcAccessInstaller>, PcHelper) {
    (mixdog_core_domains::domains::pc_access_installer::production_installer(exe), ())
}

/// The desktop's reports about the screen (`HostService`'s `ScreenEvents` port), handed to the domains before the screen sources exist:
/// it does nothing until [`compose_screen`] binds the service.
#[derive(Default)]
pub struct ScreenEventsCell {
    target: OnceLock<Arc<dyn ScreenEvents>>,
}

impl ScreenEvents for ScreenEventsCell {
    fn displays_changed(&self) {
        if let Some(target) = self.target.get() {
            target.displays_changed();
        }
    }

    fn indicator_stopped(&self, screen_id: &str) {
        if let Some(target) = self.target.get() {
            target.indicator_stopped(screen_id);
        }
    }
}

/// What the composition is built from.
pub struct ScreenInputs {
    /// The claimed desktop: the monitors, their pictures and the pill.
    pub host: Arc<dyn HostChannel>,
    /// A paired connection's device name is the phone's label on the pill.
    pub registry: Arc<DeviceRegistry>,
    /// Bound to the screen service once it exists.
    pub events: Arc<ScreenEventsCell>,
    /// The computer sessions' pool; the phone's screen takes its default session's backend. `None`: no helper and no desktop host.
    pub pool: Option<Arc<ComputerSessionPool>>,
    /// Where the `mixdog-computer` binary is found.
    pub native: Arc<NativeToolPaths>,
    pub manager: Arc<dyn ProcessManager>,
    pub pc_access: Arc<PcAccessService>,
    pub helper: PcHelper,
    /// The core's blob store as a capture of the desktop's pixels is read from it.
    pub blobs: Arc<dyn ComputerBlobs>,
    pub data_dir: PathBuf,
}

/// The phone's screen control as composed.
pub struct Screens {
    #[cfg(windows)]
    service: Option<Arc<service::ScreenService>>,
}

impl Screens {
    /// The live view's port; `None` where screen control is off.
    #[cfg(windows)]
    pub fn phone(&self) -> Option<Arc<dyn PhoneScreens>> {
        self.service.clone().map(|service| service as Arc<dyn PhoneScreens>)
    }

    #[cfg(not(windows))]
    pub fn phone(&self) -> Option<Arc<dyn PhoneScreens>> {
        None
    }

    /// The first step of the stop: every session releases its input and stops under the quit budget, before the viewers and the
    /// sender go (`SCREEN_QUIT_BUDGET_MS`).
    #[cfg(windows)]
    pub fn stop_step(&self) -> StopStep {
        let service = self.service.clone();
        (
            "phone screens",
            Box::pin(async move {
                if let Some(service) = service {
                    service.stop_for_quit().await;
                }
            }),
        )
    }

    #[cfg(not(windows))]
    pub fn stop_step(&self) -> StopStep {
        ("phone screens", Box::pin(async {}))
    }
}

/// Builds the screen sources over the ports of this core and binds the desktop's screen reports to them.
#[cfg(windows)]
pub async fn compose_screen(inputs: ScreenInputs) -> Screens {
    let ScreenInputs { host, registry, events, pool, native, manager, pc_access, helper, blobs, data_dir } = inputs;
    let off = |reason: &str| {
        tracing::error!(reason, "phone screen control is off");
        Screens { service: None }
    };
    let Some(pool) = pool else { return off("no computer helper resolves and no desktop host serves it") };
    let Some(binary) = native.resolve(mixdog_core::run_host::native_tools::NativeTool::Computer).await else {
        return off("the mixdog-computer helper is not found");
    };
    let Some(cwd) = std::env::current_dir().ok().and_then(mixdog_core_api::domain::common::AbsPath::new).or_else(|| mixdog_core_api::domain::common::AbsPath::new(data_dir)) else {
        return off("the working directory is not an absolute path");
    };
    let service = service::ScreenService::new(service::Parts { host, registry, pool, binary, cwd, manager, pc_access, helper, blobs });
    if events.target.set(service.clone()).is_err() {
        tracing::error!("the desktop's screen reports were bound twice");
    }
    Screens { service: Some(service) }
}

#[cfg(not(windows))]
pub async fn compose_screen(inputs: ScreenInputs) -> Screens {
    let ScreenInputs { host: _, registry: _, events: _, pool: _, native: _, manager: _, pc_access: _, helper: _, blobs: _, data_dir: _ } = inputs;
    tracing::error!(reason = "screen control is implemented for Windows only", "phone screen control is off");
    Screens {}
}

/// The live view's half: the sessions as the host streams them, and the sink they report to.
#[cfg(windows)]
#[path = "compose_screen_live.rs"]
pub(crate) mod live;

#[cfg(windows)]
#[path = "compose_screen_service.rs"]
mod service;
