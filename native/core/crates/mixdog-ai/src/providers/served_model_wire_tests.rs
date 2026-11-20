//! The model a compatible provider's answer names, against Node's recordings (`fixtures/provider-wire/served-model`,
//! recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs` through each provider's own Node class): Node
//! reports `response.model || useModel` (openai-compat-chat-send.mjs:321, chunk-events.mjs:56; Muse Code always sends
//! Responses). Each provider is built by the production builder from the recorded configuration and sends the recorded
//! turn over the recorder's hub: every request is compared whole with Node's, the answer whole with Node's result, and
//! the stream callbacks in order.
