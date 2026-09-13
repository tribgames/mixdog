export function createKeyedSerialQueue<K = string>(): <T>(
  key: K,
  task: () => T | Promise<T>,
) => Promise<T>;
