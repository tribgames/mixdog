//! Vertex AI open models against Node's recordings (`fixtures/provider-wire/vertex-maas`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs` through `VertexAIProvider` on a gcloud login): the adapter
//! mints a token, the first Chat Completions send is refused (a 401, a 429 answered as a JSON array, a 529) and the
//! next answers. The provider is built by the production builder from the recorded configuration and gcloud login:
//! every request (token grants included) is compared whole with Node's and the bearer with the token the last grant
//! answered; a refusal the adapter does not recover itself is retried as the loop's decider rules under the policy the
//! adapter names for the model, with the wait Node slept; the answer is compared whole with Node's result and the
//! stream callbacks in order.
