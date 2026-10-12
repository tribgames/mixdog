import { useContext, useMemo } from 'react';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Copy } from 'lucide-react';
import { t } from '../i18n';
import { useLocalImagePreview } from '../local-image-preview';
import { safeMarkdownUrl } from '../markdown-url';
import { copyTextToClipboard } from '../text-format';
import { RichMarkdownDocumentContext } from './rich-markdown-context';
import { richMarkdownLowlight } from './rich-markdown-extensions';
import { richMarkdownImagePath } from './rich-markdown-links';

/** Fenced code in the preview's code card: a language picker in the header
 *  band and lowlight-highlighted, editable code below. */
export function RichMarkdownCodeBlock({ node, updateAttributes }: NodeViewProps) {
  const { readOnly } = useContext(RichMarkdownDocumentContext);
  const language = String(node.attrs.language ?? '');
  const languages = useMemo(() => richMarkdownLowlight.listLanguages().sort(), []);
  return (
    <NodeViewWrapper className="markdown-code rich-markdown-code">
      <header contentEditable={false}>
        <select
          className="rich-markdown-code-language"
          aria-label={t('Code block language')}
          value={language}
          disabled={readOnly}
          onChange={(event) => updateAttributes({ language: event.target.value || null })}
        >
          <option value="">{t('Plain text')}</option>
          {language && !languages.includes(language) ? <option value={language}>{language}</option> : null}
          {languages.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="markdown-code-copy"
          aria-label={t('Copy code')}
          title={t('Copy code')}
          onClick={() => void copyTextToClipboard(node.textContent)}
        >
          <Copy size={14} aria-hidden="true" />
        </button>
      </header>
      <pre>
        <NodeViewContent<'code'> as="code" className={language ? `hljs language-${language}` : 'hljs'} />
      </pre>
    </NodeViewWrapper>
  );
}

function LocalImage({ projectPath, path, alt }: { projectPath: string; path: string; alt: string }) {
  const preview = useLocalImagePreview(projectPath, path);
  const name = alt || path.split('/').at(-1) || path;
  if (preview.unavailable) {
    return (
      <span className="rich-markdown-image-missing" title={path}>
        {name}
      </span>
    );
  }
  if (!preview.url) return <span className="rich-markdown-image-loading" aria-hidden="true" />;
  return <img src={preview.url} alt={name} title={path} draggable={false} />;
}

/** `![alt](src)`: local paths resolve against the document's folder through
 *  the same preview service as the Markdown preview; web images load as is. */
export function RichMarkdownImage({ node, selected }: NodeViewProps) {
  const { projectPath, relPath } = useContext(RichMarkdownDocumentContext);
  const src = String(node.attrs.src ?? '');
  const alt = String(node.attrs.alt ?? '');
  const localPath = richMarkdownImagePath(src, relPath);
  const remote = localPath === null ? safeMarkdownUrl(src, 'src') : '';
  let image: React.ReactElement;
  if (localPath !== null) image = <LocalImage projectPath={projectPath} path={localPath} alt={alt} />;
  else if (remote) image = <img src={remote} alt={alt} title={node.attrs.title ?? undefined} draggable={false} />;
  else image = <span className="rich-markdown-image-missing">{alt || src}</span>;
  return (
    <NodeViewWrapper as="span" className={`rich-markdown-image${selected ? ' is-selected' : ''}`}>
      {image}
    </NodeViewWrapper>
  );
}
