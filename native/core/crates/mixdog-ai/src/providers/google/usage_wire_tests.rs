//! Gemini usage with each field missing in turn, against Node's recordings (`fixtures/provider-wire/gemini-usage`,
//! recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs` through the Gemini API and Vertex AI express):
//! the provider is built by the production builder from the recorded configuration and sends the turn over the
//! recorder's hub: the request is compared whole with Node's, the recorded stream's reading whole with Node's result,
//! and the stream callbacks in order.
