import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { DesktopLocalPathEntry } from '../shared/contract';
import { absoluteLocalPath } from './local-files';
import { requiredString } from './ipc-validation';
import { readSecretFile, writeSecretFile } from './secret-file';
import { createKeyedSerialQueue } from '../../../../src/runtime/shared/keyed-serial-queue.mjs';
import {
  MAX_SELECTED_FILE_GRANTS,
  parseSelectedFileGrants,
  selectedFileGrantKey,
  serializeSelectedFileGrants,
} from './selected-file-grants';

interface SelectedFileAccessOptions {
  storePath: string;
  listProjects: () => Promise<Array<{ path: string }>>;
}

export class SelectedFileAccess {
  readonly #storePath;
  readonly #listProjects;
  #grants = new Map<string, string>();
  #loaded = false;
  #loadRequest: Promise<void> | null = null;
  readonly #commits = createKeyedSerialQueue();

  constructor({ storePath, listProjects }: SelectedFileAccessOptions) {
    this.#storePath = storePath;
    this.#listProjects = listProjects;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    if (this.#loadRequest) return this.#loadRequest;
    const pending = (async () => {
      if (this.#storePath) {
        // Disk/security failures must remain retryable, not become an empty
        // authoritative map that a later selection overwrites.
        const text = await readSecretFile(this.#storePath);
        let parsed = { grants: new Map<string, string>(), migrated: false };
        try {
          parsed = parseSelectedFileGrants(text ?? '[]');
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // The established malformed-document recovery remains empty.
        }
        if (parsed.migrated) await this.#persist(parsed.grants);
        this.#grants = parsed.grants;
      }
      this.#loaded = true;
    })();
    this.#loadRequest = pending;
    try {
      await pending;
    } finally {
      if (this.#loadRequest === pending) this.#loadRequest = null;
    }
  }

  async #persist(grants: Map<string, string>): Promise<void> {
    if (!this.#storePath) return;
    await writeSecretFile(
      this.#storePath,
      serializeSelectedFileGrants(grants),
    );
  }

  async describe(paths: unknown): Promise<DesktopLocalPathEntry[]> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
      throw new TypeError('paths are invalid.');
    }
    await this.#load();
    const projects = await this.#listProjects().catch(() => []);
    const pendingGrants = new Map<string, string>();
    const rows: DesktopLocalPathEntry[] = [];
    for (const raw of paths) {
      const absolutePath = absoluteLocalPath(raw);
      const info = await stat(absolutePath);
      const row: DesktopLocalPathEntry = {
        absolutePath,
        name: basename(absolutePath) || absolutePath,
        dir: info.isDirectory(),
        size: Number(info.size) || 0,
      };
      if (!row.dir) {
        const normalizedFile = process.platform === 'win32'
          ? absolutePath.toLocaleLowerCase()
          : absolutePath;
        const owner = projects
          .map((project) => ({ project, root: resolve(project.path) }))
          .filter(({ root }) => {
            const normalizedRoot = process.platform === 'win32'
              ? root.toLocaleLowerCase()
              : root;
            return normalizedFile.startsWith(normalizedRoot + sep)
              || normalizedFile === normalizedRoot;
          })
          .sort((left, right) => right.root.length - left.root.length)[0];
        if (owner) {
          row.projectPath = owner.project.path;
          row.relPath = relative(owner.root, absolutePath).replace(/\\/g, '/');
        } else {
          const accessToken = randomUUID();
          pendingGrants.set(selectedFileGrantKey(accessToken), absolutePath);
          row.projectPath = dirname(absolutePath);
          row.relPath = basename(absolutePath);
          row.accessToken = accessToken;
        }
      }
      rows.push(row);
    }
    if (pendingGrants.size) {
      // Stage the whole selection before changing authority. Only publication
      // is serialized; independent filesystem inspection remains concurrent.
      await this.#commits(this.#storePath, async () => {
        const grants = new Map(this.#grants);
        for (const [key, file] of pendingGrants) grants.set(key, file);
        while (grants.size > MAX_SELECTED_FILE_GRANTS) {
          const oldest = grants.keys().next().value;
          if (!oldest) break;
          grants.delete(oldest);
        }
        await this.#persist(grants);
        this.#grants = grants;
      });
    }
    return rows;
  }

  async requireGrant(
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown,
  ): Promise<{ root: string; rel: string; absolute: string }> {
    await this.#load();
    const token = requiredString(accessToken, 'file access token', 128);
    const granted = this.#grants.get(selectedFileGrantKey(token));
    if (!granted) throw new Error('The selected-file permission is unavailable.');
    const requested = resolve(
      requiredString(projectPath, 'projectPath'),
      requiredString(relPath, 'relPath'),
    );
    const same = process.platform === 'win32'
      ? requested.toLocaleLowerCase() === granted.toLocaleLowerCase()
      : requested === granted;
    if (!same) throw new Error('The selected-file permission does not match this path.');
    return { root: dirname(granted), rel: basename(granted), absolute: granted };
  }
}
