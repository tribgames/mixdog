//! The PC's screen control as the app composes it (Node: `main/index.ts:2321-2328` and
//! `remote-screen/screen-webrtc-sources.ts:177-209`): one secure-desktop helper shared by every screen session, whose
//! adapter is built over a fresh helper client each time the lease rebuilds it (after an install), and one lease of it
//! per viewer's session.

use std::sync::Arc;

use super::adapter::SecureDesktopAdapter;
use super::helper_client::HelperClient;
use super::helper_client::HelperConnector;
use super::installer::Timers;
use super::lease::HelperDeps;
use super::lease::HelperFrame;
use super::lease::InstallPort;
use super::lease::SecureDesktopHelper;
use super::lease::SecureDesktopLease;
use super::turn::Turn;

pub(super) struct ScreenControl {
    helper: SecureDesktopHelper<HelperFrame>,
    turn: Arc<Turn>,
}

impl ScreenControl {
    /// `connector` dials the installed helper (the client reads the install state when it is built); `installer`
    /// answers the install state and the phone's install request.
    /// `timers` is the screen control's: its sessions are given the same one, so one turn serialises them all.
    pub(super) fn new(connector: Arc<dyn HelperConnector>, installer: Arc<dyn InstallPort>, timers: Arc<dyn Timers>) -> Self {
        let turn = timers.turn().clone();
        let helper = turn.enter(|| {
            SecureDesktopHelper::new(HelperDeps {
                adapter: Box::new(move || SecureDesktopAdapter::create(Arc::new(HelperClient::new(connector.clone(), timers.clone())), timers.clone())),
                installer,
            })
        });
        Self { helper, turn }
    }

    /// A viewer session's lease on the helper (its `secure_desktop`); disposed once the session released.
    pub(super) fn lease(&self) -> Arc<SecureDesktopLease<HelperFrame>> {
        Arc::new(self.turn.enter(|| self.helper.lease()))
    }

    /// Every session is done: the helper's adapter is disposed and every lease detached.
    pub(super) fn dispose(&self) {
        self.turn.enter(|| self.helper.dispose());
    }
}
