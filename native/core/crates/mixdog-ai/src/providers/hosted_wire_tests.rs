//! A provider's own web search on the wire, per provider, against Node's recordings (`fixtures/provider-wire/hosted-search`):
//! the request `sendCandidate` makes (native-web-search.mjs:63-77) is built as the hosted sender builds it, with the tool
//! read by the production reader ([`super::hosted::web_search_from_node`]), and sent by the provider the production
//! builder builds from the recorded configuration over the recorder's hub; every request is compared whole with Node's,
//! the recorded answer (the search call, its sources and a citation as each wire reports them) whole with Node's result,
//! and the stream callbacks in order.








