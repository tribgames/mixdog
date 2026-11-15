//! The legs of the relay: the desktop leg and the phone legs it forwards for. `envelope` is the wire form between the relay
//! and a desktop leg, `policy` the pure forwarding policy (capacity, admission, attribution, oversize notices); both are
//! plain functions over plain inputs, shared by the sockets code and the tests.

pub mod envelope;
pub mod policy;
