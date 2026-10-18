// The durable copy of an approval. A phone OS may evict a web app's
// localStorage on its own (storage pressure, a WebView data trim) while its
// IndexedDB survives; losing the credential then meant a silent new claim and
// one more approval prompt on the PC for the same device. An approval is
// reported stored only once this copy is committed, and boot restores from it
// when localStorage came back empty.

const DATABASE = 'mixdog-remote-pairing';
const STORE = 'approvals';

export interface DurablePairing {
  token: string;
  e2eePublicKey: string;
  e2eeSecret: string;
  browserId: string;
  server: string;
}

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

/** One transaction, settled only when it COMPLETES: a resolved request is not
 *  yet a committed write. */
const transact = async <T>(
  factory: Factory,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const database = await openDatabase(factory);
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
};

export const saveDurablePairing = async (
  key: string,
  pairing: DurablePairing,
  factory: Factory = defaultFactory()
): Promise<void> => {
  await transact(factory, 'readwrite', (store) => store.put({ ...pairing }, key));
};

export const loadDurablePairing = async (
  key: string,
  factory: Factory = defaultFactory()
): Promise<DurablePairing | null> => {
  const value = (await transact(factory, 'readonly', (store) => store.get(key))) as Partial<DurablePairing> | undefined;
  if (!value) return null;
  const fields = ['token', 'e2eePublicKey', 'e2eeSecret', 'browserId', 'server'] as const;
  if (!fields.every((field) => typeof value[field] === 'string' && value[field])) return null;
  return value as DurablePairing;
};

export const clearDurablePairing = async (key: string, factory: Factory = defaultFactory()): Promise<void> => {
  await transact(factory, 'readwrite', (store) => store.delete(key));
};
