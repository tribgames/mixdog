//! The legs of the relay: the desktop leg and the phone legs it forwards for. `envelope` is the wire form between the relay
//! and a desktop leg, `policy` the pure forwarding policy (capacity, admission, attribution, oversize notices); both are
//! plain functions over plain inputs, shared by the sockets code and the tests. `ingress` meters and admits what a leg sends
//! over the raw byte stream of its socket.
//!
//! `hub` holds every live desktop and the phones attached to it, and routes between them; `desktop` is the desktop leg (what it is
//! told on connect and what it does with each frame it sends); `watchdog` judges a joining phone's handshake; `dispatch` is where the
//! later areas register the frame types, capabilities and revocation hooks the desktop leg hands on.

pub mod desktop;
pub mod dispatch;
pub mod envelope;
pub mod hub;
pub mod ingress;
pub mod policy;
pub mod watchdog;
