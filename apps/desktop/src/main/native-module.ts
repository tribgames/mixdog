import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The shared loader of the desktop's Node-API modules (Rust, built from native/<crate>).
 * A module is loaded at its first call, never at import, so a test or a tool that only imports the files that call it
 * does not need it built. A module that cannot be loaded at first use is a fatal error naming the file: the build
 * (prepare-runtime and verify-staged-package) guarantees the packaged one is there, a dev checkout builds it with
 * `cargo build --release` in the crate's folder.
 */
export interface NativeModuleSpec<Exports> {
  /** The crate folder under native/. */
  crate: string;
  /** The name the packaged copy has in resources/native-tools. */
  packagedFile: string;
  /** The name cargo gives the library of the crate on this platform, in the crate's target/release. */
  builtFile: (platform: NodeJS.Platform) => string;
  /** Throws when a loaded module lacks what the desktop calls (a stale build). */
  check: (exports: Exports) => void;
}

/** What cargo names `<lib>` as a dynamic library on `platform`. */
export function cargoLibraryFile(lib: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `${lib}.dll`;
  return platform === 'darwin' ? `lib${lib}.dylib` : `lib${lib}.so`;
}

/** Where the module is: the packaged copy in resources/native-tools, else the dev build of the checkout this file is in. */
export function nativeModulePath(spec: Pick<NativeModuleSpec<unknown>, 'crate' | 'packagedFile' | 'builtFile'>): string {
  if (process.versions.electron && !process.defaultApp) {
    return join(process.resourcesPath, 'native-tools', spec.packagedFile);
  }
  let root = import.meta.dirname;
  while (!existsSync(join(root, 'native', spec.crate, 'Cargo.toml'))) {
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return join(process.env.CARGO_TARGET_DIR ?? join(root, 'native', spec.crate, 'target'), 'release', spec.builtFile(process.platform));
}

const loaded = new WeakMap<object, unknown>();

/** The module's exports, loaded on the first call and kept; a module that cannot be loaded throws, naming the file. */
export function loadNativeModule<Exports>(spec: NativeModuleSpec<Exports>): Exports {
  const kept = loaded.get(spec);
  if (kept) return kept as Exports;
  const library = nativeModulePath(spec);
  try {
    const module = { exports: {} as Exports };
    process.dlopen(module as NodeJS.Module, library);
    spec.check(module.exports);
    loaded.set(spec, module.exports);
    return module.exports;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[mixdog-native] The native module ${spec.packagedFile} could not be loaded from ${library}: ${message}.`);
  }
}
