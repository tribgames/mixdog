import { createContext } from 'react';

/** The document a rich editor's node views belong to. */
export interface RichMarkdownDocument {
  projectPath: string;
  relPath: string;
  readOnly: boolean;
}

export const RichMarkdownDocumentContext = createContext<RichMarkdownDocument>({
  projectPath: '',
  relPath: '',
  readOnly: true,
});
