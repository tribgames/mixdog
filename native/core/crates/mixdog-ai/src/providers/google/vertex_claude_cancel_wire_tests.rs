//! The caller cancelling a Claude send on Vertex AI, against Node's recordings (`fixtures/provider-wire/
//! vertex-claude-cancel`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`: `opts.signal` aborted,
//! vertex-ai.mjs:507-537). The provider is built by the production builder over the product's own HTTP client, pinned
//! to a loopback TLS endpoint that answers as Node's endpoint did (`transport::loopback`), and sent through the broker,
//! the send path that owns retries and the caller's cancellation. Each step is signalled where Node's was: the held
//! request arriving (before the first byte), the first text delta (mid-stream), the send waiting in its retry wait
//! (pending after the retry's discard; Node's step is its retry sleep arming its timer). Compared: every request whole
//! (so no retry fires after the cancel), the connections the endpoint saw the client close, the callbacks in order, the
//! caller's result (Node's `AbortError` is the broker's `Cancelled`), and the admission slot released. The cancel in the
//! retry wait ends the send under a paused clock that has not moved. Every wait has one deadline naming its step.









