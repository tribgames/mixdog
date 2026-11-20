//! Remote host connections: stores, link, port forwards, attempts, login, restore and the connection service.

#[cfg(test)]
mod adoption_tests;
pub mod attempts;
pub mod cleanup_ops;
pub mod connect;
pub mod diagnostics_ops;
pub mod host_list_ops;
pub mod host_store;
pub mod link;
pub mod link_machine;
pub mod login;
pub mod model_proxy_relay;
pub mod notifier;
#[cfg(test)]
mod ops_tests;
pub mod paths;
pub mod policy;
pub mod port_forward_store;
pub mod port_forwards;
pub mod reattach;
pub mod remote_file_reader;
pub mod remote_hosts;
pub mod restore;
pub mod server_feed;
pub mod server_logins;
pub mod service;
#[cfg(test)]
mod stores_tests;
pub mod view;
pub mod window_restore_store;
