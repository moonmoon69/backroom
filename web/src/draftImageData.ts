/**
 * The pictures of a thread draft's images, in this browser's IndexedDB, keyed by the image's id in the draft
 * (draftStore.ts). A thread's images are read in the page and go with the message when it is sent (nothing is uploaded
 * before), and localStorage holds about 5 MB a site while one image may be 10 MB; IndexedDB holds far more. Kept as
 * the data URL the message sends. Without IndexedDB (blocked, or a private window that refuses it) the images live as
 * long as the page, as before.
 */
const DB_NAME = "backroom-drafts";
const STORE = "images";

let opened: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") throw new Error("no IndexedDB");
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB would not open"));
  }).catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
}

function inStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return database().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = use(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request ? request.result : undefined);
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB aborted"));
      }),
  );
}

export const saveImageData = (id: string, dataUrl: string): Promise<void> => inStore("readwrite", (store) => store.put(dataUrl, id)).then(() => undefined);

export const loadImageData = (id: string): Promise<string | null> => inStore<unknown>("readonly", (store) => store.get(id)).then((value) => (typeof value === "string" ? value : null));

export const deleteImageData = (ids: readonly string[]): Promise<void> =>
  ids.length === 0
    ? Promise.resolve()
    : inStore("readwrite", (store) => {
        for (const id of ids) store.delete(id);
      }).then(() => undefined);
