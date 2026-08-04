// The desktop TypeScript/JavaScript language service lives in the main process
// and is exposed through the LSP bridge. Monaco's editor.main imports this
// contribution for side effects; replacing only that module keeps its basic
// tokenizer and every editor contribution without starting a second TS engine.
export {};
