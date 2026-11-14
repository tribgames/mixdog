// A copy of mixdog-app-protocol src/boundary/blob_fields.json (which params of a method may carry a blob reference); sized-call.test.mjs
// asserts the two are equal, so a change to the Rust table fails there until this one follows.
export const BLOB_REF_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'turn/start': ['/input/prompt', '/input/prompt/*/text', '/input/prompt/*/data', '/input/options/pastedImages/*/content', '/input/options/pastedTexts/*/text'],
  'thread/start': ['/initialInput/prompt', '/initialInput/prompt/*/text', '/initialInput/prompt/*/data', '/initialInput/options/pastedImages/*/content', '/initialInput/options/pastedTexts/*/text'],
  'room/send': ['/input/prompt', '/input/prompt/*/text', '/input/prompt/*/data', '/input/options/pastedImages/*/content', '/input/options/pastedTexts/*/text'],
  'thread/stageAttachmentOriginal': ['/input/data'],
  'thread/resizeImage': ['/input/data'],
  'feedback/upload': ['/input/attachments/*/data'],
  'media/startMediaJob': ['/input/references/*/base64'],
  'media/cacheMediaThumbnail': ['/input/base64'],
  'voice/transcribeAudio': ['/input/data'],
  'projectFs/writeText': ['/content', '/expectedContent'],
  'projectFs/writeTextBatch': ['/files/*/content', '/files/*/expectedContent'],
  'projectFs/backup/write': ['/content', '/expectedContent'],
  'projectFs/replaceText': ['/replacement'],
  'lsp/document': ['/document/content'],
  'git/applyPatch': ['/patch'],
};
