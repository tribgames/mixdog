import { documentRelativePath } from '../MarkdownLink';
import { isLocalMarkdownLink, projectRelativeFilePath } from '../markdown-url';
import { parseLocalFileLocation } from '../../shared/local-files';

export type RichMarkdownLinkTarget =
  | { kind: 'anchor'; slug: string }
  | { kind: 'web'; url: string }
  | { kind: 'file'; rel: string; line?: number }
  | { kind: 'none' };

/** Project-relative folder of a document ('' at the Project root). */
export function documentDirectory(relPath: string): string {
  return relPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
}

/** Where a link in the document at `relPath` leads. An anchor carries its
 *  fragment as authored, for the outline's heading lookup to decode. */
export function richMarkdownLinkTarget(href: string, projectPath: string, relPath: string): RichMarkdownLinkTarget {
  const target = href.trim();
  if (!target) return { kind: 'none' };
  if (target.startsWith('#')) {
    const slug = target.slice(1);
    return slug ? { kind: 'anchor', slug } : { kind: 'none' };
  }
  if (/^(?:https?|mailto):/i.test(target)) return { kind: 'web', url: target };
  if (!isLocalMarkdownLink(target)) return { kind: 'none' };
  const location = parseLocalFileLocation(target);
  // Still percent-encoded: the resolver decodes exactly once.
  const rel = projectRelativeFilePath(projectPath, documentRelativePath(documentDirectory(relPath), location.path));
  if (!rel || rel === '.') return { kind: 'none' };
  return location.line ? { kind: 'file', rel, line: location.line } : { kind: 'file', rel };
}

/** Local image source as a Project path, resolved like the Markdown preview. */
export function richMarkdownImagePath(src: string, relPath: string): string | null {
  if (!isLocalMarkdownLink(src)) return null;
  return documentRelativePath(documentDirectory(relPath), parseLocalFileLocation(src).path);
}
