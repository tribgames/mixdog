//! The in-process half of the computer backend: phone remote-control input, the input-desktop
//! identity, displays and screen frames. Windows only; elsewhere every call reports the backend
//! unavailable. Input runs on one dedicated thread: `SendInput` and the desktop attach are
//! per-thread, and the injector releases whatever it still holds when that thread ends.

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::MediaFrameSource;

#[cfg(windows)]
mod adapter;
#[cfg(windows)]
mod helper_client;
#[cfg(any(windows, test))]
mod installer;
#[cfg(any(windows, test))]
mod installer_port;
#[cfg(any(windows, test))]
mod lease;
#[cfg(windows)]
mod monitors;
#[cfg(any(windows, test))]
mod router;
#[cfg(any(windows, test))]
mod session;
#[cfg(windows)]
mod service;
#[cfg(windows)]
#[path = "computer_screen_source.rs"]
mod source;
#[cfg(any(windows, test))]
mod switch;
#[cfg(any(windows, test))]
mod turn;
#[cfg(any(windows, test))]
mod video;
#[cfg(all(windows, test))]
mod adapter_tests;
#[cfg(all(windows, test))]
mod composed_tests;
#[cfg(all(windows, test))]
mod helper_client_tests;
#[cfg(test)]
mod installer_tests;
#[cfg(test)]
mod lease_tests;
#[cfg(test)]
mod router_tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod switch_tests;
#[cfg(test)]
mod testing;
#[cfg(test)]
mod video_tests;

/// PC access's handle on the one secure-desktop installer, with the types its calls take and answer.
#[cfg(windows)]
pub mod pc_access_helper {
    pub use super::installer::Credential;
    pub use super::installer::InstallState;
    pub use super::installer::KeyChangeOptions;
    pub use super::installer::KeyChangeOutcome;
    pub use super::installer::KeyChangeResult;
    pub use super::installer_port::PcAccessHelper;
}

/// The phone's whole-PC screen sources, with the ports they are composed over.
#[cfg(windows)]
pub mod screen_source {
    pub use super::source::AccountAdmin;
    pub use super::source::DisplayLister;
    pub use super::source::DisplayPixels;
    pub use super::source::HostDisplays;
    pub use super::source::HelperPictureFrame;
    pub use super::source::IndicatorState;
    pub use super::source::InputDesktop;
    pub use super::source::Monitor;
    pub use super::source::PcAccessAnswer;
    pub use super::source::PixelArea;
    pub use super::source::QUIT_BUDGET_MS;
    pub use super::source::ScreenAccessEnd;
    pub use super::source::ScreenFrame;
    pub use super::source::ScreenIndicatorPort;
    pub use super::source::ScreenInputHost;
    pub use super::source::ScreenPcAccessPort;
    pub use super::source::ScreenSink;
    pub use super::source::ScreenSources;
    pub use super::source::ScreenSourcesDeps;
    pub use super::source::ScreenViewer;
    pub use super::source::VideoArea;
}

#[cfg(windows)]
pub(super) use win::Screen;

#[cfg(not(windows))]
pub(super) use other::Screen;

#[cfg(not(windows))]
mod other {
    use super::*;

    fn unavailable() -> ComputerError {
        ComputerError::Unavailable { reason: "screen control is implemented for Windows only".into() }
    }

    #[derive(Default)]
    pub(in super::super) struct Screen;

    impl Screen {
        pub fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
            Err(unavailable())
        }
        pub fn release(&self) -> Result<u32, ComputerError> {
            Err(unavailable())
        }
        pub fn input_desktop(&self) -> Option<DesktopIdentity> {
            None
        }
        pub fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
            Err(unavailable())
        }
        pub fn source(&self, _: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
            Err(unavailable())
        }
    }
}

#[cfg(windows)]
mod win {
    use std::sync::Mutex;
    use std::sync::mpsc;

    use mixdog_core_api::domain::computer::PointerButton;
    use mixdog_secure_desktop::desktop;
    use mixdog_secure_desktop::inject::Injector;
    use mixdog_secure_desktop::protocol::PointerButton as WireButton;

    use super::monitors;
    use super::*;

    enum Job {
        Inject(ScreenInput, mpsc::Sender<Result<InputOutcome, ComputerError>>),
        Release(mpsc::Sender<u32>),
    }

    #[derive(Default)]
    pub(in super::super) struct Screen {
        input: Mutex<Option<mpsc::Sender<Job>>>,
    }

    fn wire(button: PointerButton) -> WireButton {
        match button {
            PointerButton::Left => WireButton::Left,
            PointerButton::Right => WireButton::Right,
            PointerButton::Middle => WireButton::Middle,
        }
    }

    fn key_code(value: u32, what: &str) -> Result<u16, ComputerError> {
        u16::try_from(value).map_err(|_| ComputerError::InvalidInput {
            reason: format!("{what} {value} is out of range"),
        })
    }

    fn apply(injector: &mut Injector, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        // Injection reaches only the ordinary desktop; while the secure desktop (UAC, lock
        // screen) has the input, whatever was held is let go and the input is refused.
        match desktop::input_desktop_name() {
            Some(name) if name.eq_ignore_ascii_case("default") => {}
            Some(_) => {
                injector.release_all();
                return Ok(InputOutcome::Rejected);
            }
            None => {
                return Err(ComputerError::Unavailable { reason: "the input desktop is unreadable".into() });
            }
        }
        match input {
            ScreenInput::Move { x, y } => injector.pointer_move(x, y),
            ScreenInput::Button { button, down, at } => match at {
                Some((x, y)) => injector.pointer_button(wire(button), down, x, y),
                None if !down => {
                    injector.release_button(wire(button));
                }
                None => {
                    return Err(ComputerError::InvalidInput {
                        reason: "a button press needs a position".into(),
                    });
                }
            },
            ScreenInput::Wheel { x, y, dx, dy } => injector.pointer_wheel(x, y, dx, dy),
            ScreenInput::Key { vk, scan, extended, down } => {
                injector.key(down, key_code(vk, "vk")?, key_code(scan, "scan")?, extended);
            }
            ScreenInput::Text(text) => injector.text(&text),
        }
        if injector.take_desktop_lost().is_some() {
            return Ok(InputOutcome::Rejected);
        }
        if injector.take_failure() {
            return Err(ComputerError::Failed {
                code: "input_blocked".into(),
                message: "the system refused the input".into(),
            });
        }
        Ok(InputOutcome::Applied)
    }

    fn input_thread() -> mpsc::Sender<Job> {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::spawn(move || {
            let mut injector = Injector::new();
            for job in rx {
                match job {
                    Job::Inject(input, reply) => {
                        let _ = reply.send(apply(&mut injector, input));
                    }
                    Job::Release(reply) => {
                        let held = injector.held_count() as u32;
                        injector.release_all();
                        let _ = reply.send(held);
                    }
                }
            }
        });
        tx
    }

    impl Screen {
        fn job<T>(&self, make: impl FnOnce(mpsc::Sender<T>) -> Job) -> Result<T, ComputerError> {
            let (reply, answer) = mpsc::channel();
            {
                let mut slot = self.input.lock().unwrap_or_else(|p| p.into_inner());
                let sender = slot.get_or_insert_with(input_thread);
                if sender.send(make(reply)).is_err() {
                    *slot = None;
                    return Err(ComputerError::Failed {
                        code: "input_thread_exited".into(),
                        message: "the input thread stopped".into(),
                    });
                }
            }
            answer.recv().map_err(|_| ComputerError::Failed {
                code: "input_thread_exited".into(),
                message: "the input thread stopped".into(),
            })
        }

        pub fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
            self.job(|reply| Job::Inject(input, reply))?
        }

        pub fn release(&self) -> Result<u32, ComputerError> {
            self.job(Job::Release)
        }

        pub fn input_desktop(&self) -> Option<DesktopIdentity> {
            let name = desktop::input_desktop_name()?;
            Some(DesktopIdentity { session: desktop::active_console_session(), desktop: name.to_lowercase() })
        }

        /// Every monitor of the PC with its rectangle in physical pixels and its scale.
        pub fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
            Ok(monitors::displays())
        }

        /// The pictures of one monitor at its own size, thirty a second.
        pub fn source(&self, display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
            monitors::source(display)
        }
    }
}
