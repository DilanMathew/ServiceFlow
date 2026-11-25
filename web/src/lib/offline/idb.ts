/** Minimal promise wrapper over IndexedDB (no dependency). Two stores: `kv` and `outbox`. */
const DB_NAME = 'serviceflow';
const VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

export const idbAvailable = () => typeof indexedDB !== 'undefined';

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('outbox')) {
        const s = db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
        s.createIndex('user', 'userId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

async function store(name: 'kv' | 'outbox', mode: IDBTransactionMode) {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const kv = {
  async get<T>(key: string): Promise<T | undefined> { return wrap((await store('kv', 'readonly')).get(key)) as Promise<T | undefined>; },
  async set(key: string, value: unknown) { await wrap((await store('kv', 'readwrite')).put(value, key)); },
  async del(key: string) { await wrap((await store('kv', 'readwrite')).delete(key)); },
  async delPrefix(prefix: string) {
    const s = await store('kv', 'readwrite');
    await wrap(s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)));
  },
};

export const outboxStore = {
  async add<T extends object>(item: T): Promise<number> { return wrap((await store('outbox', 'readwrite')).add(item)) as Promise<number>; },
  async put<T extends object>(item: T) { await wrap((await store('outbox', 'readwrite')).put(item)); },
  async del(id: number) { await wrap((await store('outbox', 'readwrite')).delete(id)); },
  async byUser<T>(userId: string): Promise<T[]> { return wrap((await store('outbox', 'readonly')).index('user').getAll(userId)) as Promise<T[]>; },
  async clearUser(userId: string) {
    const items = await this.byUser<{ id: number }>(userId);
    const s = await store('outbox', 'readwrite');
    await Promise.all(items.map((i) => wrap(s.delete(i.id))));
  },
};
