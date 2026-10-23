// The tool output facts reader (transcript-tool-model.ts) for the host's main
// process: the serializer runs the code the phone reads a row's header with.
// Through this module the main build bundles it without type-checking the
// renderer's DOM-bound modules (tool-output-facts.d.mts types it).
export { REMOTE_OUTPUT_FACTS_FIELD } from './transcript-tool-core';
export { outputFactsOf } from './transcript-tool-model';
