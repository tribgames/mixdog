export type IdbFactory = Pick<IDBFactory, 'open'>;

export const defaultIdbFactory = (): IdbFactory => {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable.');
  return factory;
};

/** Version 1 of a database holding one object store. */
export const openSingleStoreDatabase = (factory: IdbFactory, database: string, store: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = factory.open(database, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
