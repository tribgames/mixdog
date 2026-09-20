/**
 * read-tool/image-fast-path.mjs — image files (png/jpg/jpeg/gif/webp) return
 * an MCP image block so the model can actually SEE the image. Batch children
 * opt into this rich path for full image reads and the parent flattens each
 * child's content parts into one structured result; mediaTextOnly remains
 * available for callers that explicitly require a flat text result.
 */
import { imageMimeForPath, readImageAsContent } from '../read-image.mjs';
import { guardedReadError, PATH_STRING_GUARDS } from './reach-preflight.mjs';

// Returns a guard error string, the image content result, or null when the
// read is not an image read (or the image reader produced nothing).
export async function readImageFastPath(args, workDir, options, helpers) {
  if (options?.mediaTextOnly === true || typeof args.path !== 'string' || !imageMimeForPath(args.path)) return null;
  const { normalizeInputPath, normalizeOutputPath, resolveAgainstCwd } = helpers;
  const norm = normalizeInputPath(args.path);
  // Device-file / UNC / Windows-device / ADS guards must run BEFORE the
  // image fast-path so stat/readFile of a UNC/device path cannot bypass the
  // checks the normal read path enforces (NTLM hash leak, raw-device
  // access, ADS).
  const normError = guardedReadError(norm, helpers);
  if (normError) return normError;
  const full = resolveAgainstCwd(norm, workDir);
  const fullError = guardedReadError(full, helpers, PATH_STRING_GUARDS);
  if (fullError) return fullError;
  const result = await readImageAsContent(
    full,
    normalizeOutputPath(norm),
    options?._preflightStats?.get?.(full) || null
  );
  return result || null;
}
