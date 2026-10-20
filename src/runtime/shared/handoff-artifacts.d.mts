export interface HandoffFile {
  name: string;
  path: string;
  kind: 'image' | 'file' | 'text';
  mimeType: string;
  size: number;
  /** Attachment-store reference when the file was stored. */
  id?: string;
}
export function normalizeHandoffFiles(files: unknown): HandoffFile[];
export function artifactLines(files: unknown, omitted?: number, options?: { ids?: boolean }): string[];
export interface HandoffRecord {
  id: string;
  attachmentRef: string;
  kind: 'image' | 'file' | 'text';
  name: string;
  mimeType: string;
  size: number;
}
export function artifactRecords(files: unknown): HandoffRecord[];
