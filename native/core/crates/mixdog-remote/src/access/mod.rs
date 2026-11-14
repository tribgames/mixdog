//! Remote access as the core serves it: the device-wide settings, the live relay runtime, and the
//! `remoteAccess` domain service over both (`desktop-service.ts` `createRemoteAccess`).

pub mod legacy_revokes;
pub mod runtime;
pub mod settings;

pub use runtime::{LegLink, LegSend, OnTick, PairCodeSink, PairEffectsFactory, PairWiring, RemoteError, RemoteEvents, RemoteRuntime, RuntimeConfig, RuntimeSink};
pub use settings::{AccessSettings, SettingsView};
