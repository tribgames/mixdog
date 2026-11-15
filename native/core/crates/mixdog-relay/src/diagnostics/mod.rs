//! Periodic socket diagnostics (`lib/relay-diagnostics.mjs`): each relay socket's buffered bytes (bytes the socket accepted
//! that the network has not taken yet) beside the relay's scheduling lag. Bytes forwarded say how much moved; this says
//! whether the wire or the process kept up. The line goes to the relay's own log channel and is written only while at least
//! one phone is connected.
//!
//! [`report`] builds the line from a snapshot the legs code passes in and runs the 30 s report; [`lag`] measures the runtime.

pub mod lag;
pub mod report;

pub use lag::{LagProbe, LagWindow};
pub use report::{
    DesktopSockets, LoopDelayProbe, PhoneSocket, SOCKET_REPORT_INTERVAL, Snapshot, SocketDiagnostics, collect_sockets,
    start_socket_diagnostics, start_socket_diagnostics_with, watch_interval,
};
