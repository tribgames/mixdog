//! Claude on Vertex AI against Node's recordings (`fixtures/provider-wire/vertex-claude`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs` through `VertexAIProvider` on a gcloud login): the adapter
//! mints a token and sends the Anthropic request through streamRawPredict (plain; with tools and effort; refused once
//! with a 529, retried as the loop's decider rules under the policy the adapter names for the model, with the wait Node
//! slept). The provider is built by the production builder from the recorded configuration and gcloud login: every
//! request (the token grant included) is compared whole with Node's, the bearer with the token the grant answered, the
//! answer whole with Node's result, and the stream callbacks in order.
