import { useEffect, useState, type RefObject } from 'react';
import { absolutePathsForDragPayload, dataTransferHasDroppableFiles, readFileDragPayload } from './file-drag';

/**
 * Native and internal file drops onto the composer. Owns the "dragging files"
 * highlight and routes a drop to the right attach path: project-scoped
 * payloads from the SAME project become mentions/attachments, every other
 * payload is attached by absolute path, and raw DataTransfer files are read
 * directly.
 */
export function useComposerFileDrop({
  dropTargetRef,
  transitioningRef,
  projectScope,
  attachFiles,
  attachLocalPaths,
  attachProjectPaths,
  insertAbsolutePaths,
}: {
  dropTargetRef: RefObject<HTMLElement | null>;
  transitioningRef: RefObject<boolean>;
  projectScope: string;
  attachFiles: (files: FileList | File[]) => Promise<void>;
  attachLocalPaths: (paths: string[]) => Promise<void>;
  insertAbsolutePaths: (paths: string[]) => void;
  attachProjectPaths: (projectPath: string, paths: string[]) => Promise<void>;
}) {
  const [draggingFiles, setDraggingFiles] = useState(false);

  useEffect(() => {
    const target = dropTargetRef.current;
    if (!target) return;
    const containsInput = (event: DragEvent) =>
      Boolean(event.dataTransfer && dataTransferHasDroppableFiles(event.dataTransfer));
    const clearDraggingFiles = () => setDraggingFiles(false);
    const onDragEnter = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (transitioningRef.current) return;
      setDraggingFiles(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = transitioningRef.current ? 'none' : 'copy';
      }
      if (!transitioningRef.current) setDraggingFiles(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget && target.contains(event.relatedTarget as Node)) return;
      clearDraggingFiles();
    };
    const onWindowDragOver = (event: DragEvent) => {
      if (!containsInput(event)) return;
      if (event.target instanceof Node && target.contains(event.target)) return;
      clearDraggingFiles();
    };
    const onDrop = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clearDraggingFiles();
      if (transitioningRef.current || !event.dataTransfer) return;
      const payload = readFileDragPayload(event.dataTransfer);
      if (payload) {
        if (payload.kind === 'project') {
          const source = payload.projectPath.replace(/[\\/]+/g, '/').toLocaleLowerCase();
          const targetProject = projectScope.replace(/[\\/]+/g, '/').toLocaleLowerCase();
          if (source && targetProject && source === targetProject) {
            void attachProjectPaths(payload.projectPath, payload.paths);
            return;
          }
        }
        void attachLocalPaths(absolutePathsForDragPayload(payload));
        return;
      }
      const itemFiles: File[] = [];
      const directoryPaths: string[] = [];
      for (const item of Array.from(event.dataTransfer.items)) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        const path = item.webkitGetAsEntry?.()?.isDirectory
          ? window.mixdogDesktop?.folderPathForFile?.(file)
          : '';
        if (path) directoryPaths.push(path);
        else itemFiles.push(file);
      }
      void attachFiles(itemFiles.length || directoryPaths.length ? itemFiles : event.dataTransfer.files);
      insertAbsolutePaths(directoryPaths);
    };
    target.addEventListener('dragenter', onDragEnter);
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('dragleave', onDragLeave);
    target.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onWindowDragOver, true);
    window.addEventListener('drop', clearDraggingFiles, true);
    window.addEventListener('dragend', clearDraggingFiles, true);
    window.addEventListener('blur', clearDraggingFiles);
    return () => {
      target.removeEventListener('dragenter', onDragEnter);
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('dragleave', onDragLeave);
      target.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onWindowDragOver, true);
      window.removeEventListener('drop', clearDraggingFiles, true);
      window.removeEventListener('dragend', clearDraggingFiles, true);
      window.removeEventListener('blur', clearDraggingFiles);
    };
  }, [attachFiles, attachLocalPaths, attachProjectPaths, insertAbsolutePaths, dropTargetRef, projectScope, transitioningRef]);

  return { draggingFiles, setDraggingFiles };
}
