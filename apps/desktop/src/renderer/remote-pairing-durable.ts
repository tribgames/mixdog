import { defaultIdbFactory, openSingleStoreDatabase, type IdbFactory } from './remote-idb';

const DATABASE = 'mixdog-remote-pairing';
const STORE = 'approvals';

export interface DurablePairing {
  token: string;
  e2eePublicKey: string;
  e2eeSecret: string;
  browserId: string;
  server: string;
}

/** One transaction, settled only when it COMPLETES: a resolved request is not
 *  yet a committed write. */
const transact = async <T>(
  factory: IdbFactory,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const database = await openSingleStoreDatabase(factory, DATABASE, STORE);
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
  factory: IdbFactory = defaultIdbFactory()
): Promise<void> => {
  await transact(factory, 'readwrite', (store) => store.put({ ...pairing }, key));
};

export const loadDurablePairing = async (
  key: string,
  factory: IdbFactory = defaultIdbFactory()
): Promise<DurablePairing | null> => {
  const value = (await transact(factory, 'readonly', (store) => store.get(key))) as Partial<DurablePairing> | undefined;
  if (!value) return null;
  const fields = ['token', 'e2eePublicKey', 'e2eeSecret', 'browserId', 'server'] as const;
  if (!fields.every((field) => typeof value[field] === 'string' && value[field])) return null;
  return value as DurablePairing;
};

export const clearDurablePairing = async (key: string, factory: IdbFactory = defaultIdbFactory()): Promise<void> => {
  await transact(factory, 'readwrite', (store) => store.delete(key));
};
