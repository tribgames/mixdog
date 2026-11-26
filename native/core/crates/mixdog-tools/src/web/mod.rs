//! `web_search`, `web_fetch`, `local_fetch`, `image_fetch` (WP-TOOLS-WEB).

mod args;
mod cache;
mod cdp;
mod error;
mod extract;
mod extract_host;
mod format;
mod gai;
mod hosted_routes;
mod hosted_search;
mod hosted_sender;
mod lanes;
pub use hosted_sender::usage_object;
mod hosted_usage;
mod http;
mod pipeline;
mod public_get;
mod render;
mod search;
mod ssrf;
mod tools;

#[cfg(test)]
mod acp_search_tests;
#[cfg(test)]
mod hosted_native_tests;
#[cfg(test)]
mod render_tests;
#[cfg(test)]
mod tests;

pub use cache::CacheFile;
pub use error::FetchError;
pub use error::FetchKind;
pub use error::LookupFailure;
pub use extract::Extracted;
pub use extract::extract_document;
pub use extract_host::EXTRACT_METHOD;
pub use extract_host::HostExtractor;
pub use extract_host::PageExtractor;
pub use extract_host::answer as extract_answer;
pub use hosted_routes::ConfiguredSearchRoutes;
pub use hosted_routes::SearchHost;
pub use hosted_routes::SearchProvider;
pub use hosted_search::AcpSearchBackend;
pub use hosted_search::AcpSearchCall;
pub use hosted_search::AcpSearchError;
pub use hosted_search::AcpSearchErrorKind;
pub use hosted_search::AcpSearchReply;
pub use hosted_search::AcpSearchRequest;
pub use hosted_search::AcpSendReply;
pub use hosted_search::HostedSearchCall;
pub use hosted_search::HostedSearchError;
pub use hosted_search::HostedSearchReply;
pub use hosted_search::HostedSearchSender;
pub use hosted_search::HostedWebSearch;
pub use hosted_search::SearchCandidate;
pub use hosted_search::SearchFamily;
pub use hosted_search::SearchRouteResolution;
pub use hosted_search::SearchRoutes;
pub use hosted_sender::ProviderSearchSender;
pub use hosted_sender::SenderDeps;
pub use hosted_usage::NativeSearchUsageSinks;
pub use hosted_usage::Release;
pub use hosted_usage::UsageSink;
pub use hosted_usage::usage_delta;
pub use lanes::WebLanes;
pub use pipeline::PageRenderer;
pub use pipeline::StagePage;
pub use public_get::PublicError;
pub use public_get::PublicGet;
pub use public_get::PublicReply;
pub use render::BrowserEndpoint;
pub use render::BrowserRenderer;
pub use search::NativeSearchError;
pub use search::NativeSearchRequest;
pub use search::NativeSearchResult;
pub use search::NativeSource;
pub use search::NativeWebSearch;
pub use search::SearchCall;
pub use tools::WebConfig;
pub use tools::WebService;
