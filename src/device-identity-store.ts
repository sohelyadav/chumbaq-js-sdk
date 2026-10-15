import { Diagnostics } from './diagnostics';

/**
 * The device id, in a store a service worker can also read.
 *
 * Identity itself lives in `localStorage` — synchronous, which is why the
 * rest of the SDK can treat it as a plain field — and a
 * `ServiceWorkerGlobalScope` has no `localStorage` at all. A worker that
 * builds a `Dyplink` therefore mints a brand new id on every activation,
 * which is the whole reason push engagement could not be reported from a
 * worker. IndexedDB is reachable from both a page and its workers, so the
 * page mirrors its id here and the worker reads it back: one device, one id,
 * whichever context reports.
 *
 * Only an id that came out of durable storage is ever written. A page
 * without `localStorage` (Safari in private browsing) mints a fresh id per
 * page load, and mirroring one of those would leave a worker reporting
 * against an id that died when the tab closed.
 *
 * Every operation answers rather than throws: `indexedDB` is absent under
 * SSR and in Node, `open` itself throws in some private-browsing modes, and
 * none of that is worth breaking a host's page over. A store that cannot be
 * reached simply has no id in it, which is the one case push reporting still
 * refuses outright.
 */
const DB_NAME = 'dyplink';
const DB_VERSION = 1;
const STORE_NAME = 'identity';
const FINGERPRINT_KEY = 'device_fingerprint';

export class DeviceIdentityStore {
  private diagnostics: Diagnostics;

  /** Opened once per instance; `null` once it is known to be unreachable. */
  private connection: Promise<IDBDatabase | null> | null = null;

  constructor(diagnostics: Diagnostics = new Diagnostics()) {
    this.diagnostics = diagnostics;
  }

  /** The mirrored device id, or `null` when there is none to be had. */
  async read(): Promise<string | null> {
    const db = await this.open();
    if (!db) return null;

    try {
      const value = await this.settle<unknown>(
        db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(FINGERPRINT_KEY),
      );
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch (error) {
      this.diagnostics.warn('the mirrored device identity could not be read', error);
      return null;
    }
  }

  /** Mirrors the id a page restored from durable storage. */
  async write(deviceFingerprint: string): Promise<void> {
    const db = await this.open();
    if (!db) return;

    try {
      await this.settle(
        db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(deviceFingerprint, FINGERPRINT_KEY),
      );
    } catch (error) {
      this.diagnostics.warn('the device identity could not be mirrored for this origin’s workers', error);
    }
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.connection) return this.connection;

    this.connection = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        if (typeof indexedDB === 'undefined') {
          resolve(null);
          return;
        }
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        // Private browsing refuses the open outright in some browsers.
        this.diagnostics.warn('IndexedDB is not available, so this device’s workers cannot report push engagement', error);
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.diagnostics.warn('IndexedDB could not be opened', request.error);
        resolve(null);
      };
      // Another tab holds an older version open; waiting would hang the
      // caller, and a mirror is not worth that.
      request.onblocked = () => resolve(null);
    });

    return this.connection;
  }

  private settle<T>(request: IDBRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }
}
