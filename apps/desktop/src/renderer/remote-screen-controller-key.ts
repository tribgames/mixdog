// The phone's controller key for the secure-desktop helper
// (shared/secure-desktop-grant.ts): one non-extractable P-256 key per PAIRED PC,
// kept in IndexedDB as a CryptoKey (it survives structured clone, its bytes are
// never readable) and reused by every session until that pairing is dropped.
//
// Per pairing, not per device: the helper enrolls this key's public half, so
// the key is exactly as long-lived as the trust the PC placed in this phone.
// Unpairing one PC (remote-shim-pairing `resetApprovalAndAsk`) then retires
// that PC's key and nothing else, and pairing again mints a key the old
// enrollment cannot be used with. A device-wide key would outlive the pairing
// it was enrolled under and tie every PC this phone knows to one identity.
import {
  generateSecureDesktopControllerKey,
  isSecureDesktopControllerKey,
  type SecureDesktopControllerKey,
} from '../shared/secure-desktop-grant';
import { readRemoteDeviceId, remotePairingKeys, REMOTE_PAIRING_STORAGE_KEYS } from './remote-pairing-recovery';

const DATABASE = 'mixdog-remote-screen-controller';
const STORE = 'keys';

type Factory = Pick<IDBFactory, 'open'>;

const defaultFactory = (): Factory => {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable.');
  return factory;
};

const openDatabase = (factory: Factory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** One transaction, settled when it COMPLETES with the value `work` reported. */
async function transact<T>(
  factory: Factory,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, report: (value: T) => void) => void
): Promise<T> {
  const database = await openDatabase(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      let reported: T | undefined;
      const transaction = database.transaction(STORE, mode);
      transaction.oncomplete = () => resolve(reported as T);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      work(transaction.objectStore(STORE), (value) => {
        reported = value;
      });
    });
  } finally {
    database.close();
  }
}

/** A stored value that is a usable key: a valid public half and a private
 *  ECDSA key that cannot be exported. Anything else is as good as absent. */
function readStoredKey(value: unknown): SecureDesktopControllerKey | null {
  if (!value || typeof value !== 'object') return null;
  const { publicKey, privateKey } = value as Partial<SecureDesktopControllerKey>;
  if (!isSecureDesktopControllerKey(publicKey)) return null;
  if (!privateKey || privateKey.type !== 'private' || privateKey.extractable) return null;
  if (privateKey.algorithm?.name !== 'ECDSA') return null;
  return { publicKey, privateKey };
}

/** The key stored for this pairing, or null when there is none. */
export function loadControllerKey(scope: string, factory: Factory = defaultFactory()): Promise<SecureDesktopControllerKey | null> {
  return transact<SecureDesktopControllerKey | null>(factory, 'readonly', (store, report) => {
    const request = store.get(scope);
    request.onsuccess = () => report(readStoredKey(request.result));
  });
}

/** The key for this pairing, minted and stored first if there is none. The
 *  check-and-store runs in one transaction, so two tabs racing to create it
 *  end up sharing the first one stored. */
export async function ensureControllerKey(
  scope: string,
  factory: Factory = defaultFactory()
): Promise<SecureDesktopControllerKey> {
  const existing = await loadControllerKey(scope, factory);
  if (existing) return existing;
  const fresh = await generateSecureDesktopControllerKey();
  return transact<SecureDesktopControllerKey>(factory, 'readwrite', (store, report) => {
    const request = store.get(scope);
    request.onsuccess = () => {
      const kept = readStoredKey(request.result);
      if (kept) {
        report(kept);
        return;
      }
      store.put({ publicKey: fresh.publicKey, privateKey: fresh.privateKey }, scope);
      report(fresh);
    };
  });
}

// The "install prompt was already requested automatically" mark of a pairing:
// a record beside its key (same store, scope + suffix), so retiring the pairing
// deletes both together and a new pairing starts without it.
const autoRequestedKey = (scope: string): string => `${scope}#helper-auto-requested`;

/** Whether this pairing already made its one automatic install request. */
export function hasAutoRequestedHelper(scope: string, factory: Factory = defaultFactory()): Promise<boolean> {
  return transact<boolean>(factory, 'readonly', (store, report) => {
    const request = store.get(autoRequestedKey(scope));
    request.onsuccess = () => report(request.result === true);
  });
}

/** Records that this pairing made its automatic install request. */
export async function markAutoRequestedHelper(scope: string, factory: Factory = defaultFactory()): Promise<void> {
  await transact<undefined>(factory, 'readwrite', (store) => {
    store.put(true, autoRequestedKey(scope));
  });
}

/** The page-scope state of a pairing's automatic request: shared by every pane
 *  mount, so a request that went out stays made even if its mark could not be
 *  written. The stored mark is the record across reloads. */
export interface AutoRequestGuard {
  running: boolean;
  done: boolean;
}
const autoRequestGuards = new Map<string, AutoRequestGuard>();

export function autoRequestGuard(scope: string): AutoRequestGuard {
  let guard = autoRequestGuards.get(scope);
  if (!guard) {
    guard = { running: false, done: false };
    autoRequestGuards.set(scope, guard);
  }
  return guard;
}

/** Forget this pairing's key and its automatic-request mark (the PC was unpaired). */
export async function clearControllerKey(scope: string, factory: Factory = defaultFactory()): Promise<void> {
  autoRequestGuards.delete(scope);
  await transact<undefined>(factory, 'readwrite', (store) => {
    store.delete(scope);
    store.delete(autoRequestedKey(scope));
  });
}

/** The pairing a page belongs to: the storage key its credential lives under
 *  (shim `pairingKeys.token`), which names one relay origin + one PC. */
export function controllerKeyScopeFor(page: {
  origin: string;
  pathname: string;
  cookie: string;
  deviceLabel: string;
}): string {
  const deviceId = readRemoteDeviceId(page.pathname, page.cookie) || page.deviceLabel;
  return remotePairingKeys(page.origin, deviceId).token;
}

export function controllerKeyScope(): string {
  let deviceLabel = '';
  try {
    deviceLabel = localStorage.getItem(REMOTE_PAIRING_STORAGE_KEYS.device) || '';
  } catch {
    /* the route or cookie still names the PC */
  }
  return controllerKeyScopeFor({
    origin: location.origin,
    pathname: location.pathname,
    cookie: document.cookie,
    deviceLabel,
  });
}

/** The keys of one pairing, loaded once and kept for the page's life so a
 *  grant can be signed without a database read in front of it. */
export function createControllerKeys(scope: () => string = controllerKeyScope, factory?: Factory) {
  let cached: { scope: string; key: SecureDesktopControllerKey } | null = null;
  let creating: Promise<SecureDesktopControllerKey> | null = null;
  const remember = (key: SecureDesktopControllerKey, at: string): SecureDesktopControllerKey => {
    cached = { scope: at, key };
    return key;
  };
  return {
    /** The existing key, or null; never creates one. */
    async load(): Promise<SecureDesktopControllerKey | null> {
      const at = scope();
      if (cached?.scope === at) return cached.key;
      const key = await loadControllerKey(at, factory);
      return key ? remember(key, at) : null;
    },
    /** The key, created on first use (the install request needs it). */
    ensure(): Promise<SecureDesktopControllerKey> {
      const at = scope();
      if (cached?.scope === at) return Promise.resolve(cached.key);
      creating ??= ensureControllerKey(at, factory)
        .then((key) => remember(key, at))
        .finally(() => {
          creating = null;
        });
      return creating;
    },
    /** Whether this pairing already made its one automatic install request. */
    autoRequested: (): Promise<boolean> => hasAutoRequestedHelper(scope(), factory),
    markAutoRequested: (): Promise<void> => markAutoRequestedHelper(scope(), factory),
    autoGuard: (): AutoRequestGuard => autoRequestGuard(scope()),
    async clear(): Promise<void> {
      cached = null;
      await clearControllerKey(scope(), factory);
    },
  };
}
