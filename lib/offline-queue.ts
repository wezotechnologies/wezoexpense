/**
 * Offline outbox (spec 13): "let a user queue an upload while offline, syncing
 * when back online".
 *
 * A queued item holds the transaction payload plus, optionally, the receipt
 * file as a Blob. IndexedDB is used rather than localStorage because it stores
 * binary directly and has no practical size ceiling for a few photos.
 *
 * Draining happens here, in the page, rather than in the service worker: the
 * flow is upload-then-create, and keeping it in one place avoids maintaining
 * the same two-step logic twice. The worker's background-sync handler simply
 * posts DRAIN_OUTBOX to any open tab.
 *
 * Browser-only module — never imported by server code.
 */

const DB_NAME = "wezo-offline";
const DB_VERSION = 1;
const STORE = "outbox";

export type OutboxItem = {
  id?: number;
  createdAt: number;
  /** Transaction payload for POST /api/transactions. */
  payload: Record<string, unknown>;
  /** Receipt bytes, if one was attached before going offline. */
  file?: Blob;
  fileName?: string;
  fileType?: string;
  attempts: number;
  lastError?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

// ---------------------------------------------------------------------------
// Observable count
//
// The outbox is an external system, so it exposes a subscribe/snapshot pair
// that React can read with useSyncExternalStore. Reading IndexedDB is async, so
// the snapshot serves a synchronously-readable cache that is refreshed whenever
// the queue changes.
// ---------------------------------------------------------------------------

export type OutboxState = { count: number; draining: boolean };

const IDLE: OutboxState = { count: 0, draining: false };

/**
 * The snapshot object is replaced only when a value actually changes.
 * useSyncExternalStore compares snapshots by identity, so returning a fresh
 * object on every read would loop forever.
 */
let snapshot: OutboxState = IDLE;
let primed = false;
const listeners = new Set<() => void>();

function publish(next: OutboxState): void {
  if (next.count === snapshot.count && next.draining === snapshot.draining) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function announce(): void {
  window.dispatchEvent(new Event("wezo:outbox-changed"));
  void refreshOutboxCount();
}

/** Re-reads the queue length and notifies subscribers if it moved. */
export async function refreshOutboxCount(): Promise<void> {
  publish({ count: await outboxCount(), draining });
}

export function subscribeOutbox(onChange: () => void): () => void {
  listeners.add(onChange);
  // First subscriber primes the cache from storage.
  if (!primed) {
    primed = true;
    void refreshOutboxCount();
  }
  return () => listeners.delete(onChange);
}

export function getOutboxSnapshot(): OutboxState {
  return snapshot;
}

/** Server snapshot: nothing is queued during SSR. */
export function getOutboxServerSnapshot(): OutboxState {
  return IDLE;
}

export async function enqueue(
  item: Omit<OutboxItem, "id" | "createdAt" | "attempts">,
): Promise<void> {
  await tx("readwrite", (store) =>
    store.add({ ...item, createdAt: Date.now(), attempts: 0 }),
  );
  announce();

  // Ask for a background sync where supported, so the worker can nudge us even
  // if the user closes and reopens the app.
  try {
    const registration = await navigator.serviceWorker?.ready;
    const sync = (
      registration as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      }
    )?.sync;
    await sync?.register("wezo-outbox");
  } catch {
    // Background Sync is not available (Safari); the 'online' listener covers it.
  }
}

export async function listOutbox(): Promise<OutboxItem[]> {
  try {
    return await tx<OutboxItem[]>("readonly", (store) => store.getAll());
  } catch {
    return [];
  }
}

export async function outboxCount(): Promise<number> {
  try {
    return await tx<number>("readonly", (store) => store.count());
  } catch {
    return 0;
  }
}

async function remove(id: number): Promise<void> {
  await tx("readwrite", (store) => store.delete(id));
  announce();
}

async function update(item: OutboxItem): Promise<void> {
  await tx("readwrite", (store) => store.put(item));
  announce();
}

/** Give up on an item after this many failed attempts. */
const MAX_ATTEMPTS = 5;

export type DrainResult = { sent: number; failed: number; remaining: number };

/**
 * Sends everything queued. Safe to call repeatedly and concurrently — a second
 * call while one is running is a no-op.
 */
let draining = false;

export async function drainOutbox(): Promise<DrainResult> {
  if (draining || !navigator.onLine) {
    return { sent: 0, failed: 0, remaining: await outboxCount() };
  }
  draining = true;
  publish({ count: snapshot.count, draining: true });

  let sent = 0;
  let failed = 0;

  try {
    const items = await listOutbox();

    for (const item of items) {
      if (item.id === undefined) continue;

      try {
        const payload = { ...item.payload };

        // Upload the receipt first, so the transaction can reference its key.
        if (item.file) {
          const form = new FormData();
          form.append(
            "file",
            item.file,
            item.fileName ?? `receipt.${(item.fileType ?? "image/jpeg").split("/")[1]}`,
          );
          const uploadResponse = await fetch("/api/upload", {
            method: "POST",
            body: form,
          });
          if (!uploadResponse.ok) throw new Error(await describe(uploadResponse));
          const uploaded = await uploadResponse.json();
          payload.receiptBlobKey = uploaded.blobKey;
          payload.receiptMime = uploaded.mime;
        }

        const response = await fetch("/api/transactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          await remove(item.id);
          sent++;
          continue;
        }

        // A validation failure will never succeed on retry, so drop it rather
        // than looping forever. Anything else is worth retrying.
        if (response.status === 422 || response.status === 400) {
          await remove(item.id);
          failed++;
          continue;
        }

        throw new Error(await describe(response));
      } catch (error) {
        const attempts = item.attempts + 1;
        const message = error instanceof Error ? error.message : "Unknown error";

        if (attempts >= MAX_ATTEMPTS) {
          await remove(item.id);
          failed++;
        } else {
          await update({ ...item, attempts, lastError: message });
        }
        // Stop on the first failure: if the network just dropped again,
        // hammering the rest of the queue achieves nothing.
        break;
      }
    }
  } finally {
    draining = false;
    await refreshOutboxCount();
  }

  return { sent, failed, remaining: snapshot.count };
}

async function describe(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body?.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}
