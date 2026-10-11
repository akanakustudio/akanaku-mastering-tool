// Saved work (detailed design 13.1, 17.5): workspace state and the imported song files live in
// IndexedDB, rendered audio in OPFS. Everything stays in this browser (NFR-09).
import { openDB, type IDBPDatabase } from "idb";

type Schema = { workspace: unknown; sources: File };

let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  dbPromise ??= openDB("akmaster", 1, {
    upgrade(d) {
      d.createObjectStore("workspace");
      d.createObjectStore("sources");
    },
  });
  return dbPromise;
}

export async function loadWorkspace<T>(key: "single" | "album"): Promise<T | undefined> {
  return (await (await db()).get("workspace", key)) as T | undefined;
}

export async function saveWorkspace(key: "single" | "album", value: unknown) {
  await (await db()).put("workspace", value, key);
}

export async function clearWorkspace(key: "single" | "album") {
  await (await db()).delete("workspace", key);
}

/** Keeps a copy of an imported song so the work can be restored after the tab is closed. */
export async function storeSource(id: string, file: File) {
  await (await db()).put("sources", file, id);
  requestPersist();
}

export async function loadSource(id: string): Promise<File | undefined> {
  return (await (await db()).get("sources", id)) as Schema["sources"] | undefined;
}

export async function deleteSources(ids: string[]) {
  const tx = (await db()).transaction("sources", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

/** Removes rendered audio from OPFS (album/<id>.f32, single/after.f32, …). */
export async function deleteRendered(paths: string[]) {
  const root = await navigator.storage.getDirectory();
  for (const path of paths) {
    const parts = path.split("/");
    try {
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      await dir.removeEntry(parts[parts.length - 1]);
    } catch {
      // already gone
    }
  }
}

let persistRequested = false;
/** Ask the browser not to evict our storage (detailed design 4.2; W-ST-002 if refused). */
function requestPersist() {
  if (persistRequested) return;
  persistRequested = true;
  void navigator.storage.persist?.().catch(() => false);
}

/** Debounced saver that skips identical consecutive snapshots. */
export function autosaver(key: "single" | "album", delayMs = 800) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastJson = "";
  return (value: unknown) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const json = JSON.stringify(value, (_k, v) => (v instanceof File ? undefined : v));
      if (json === lastJson) return;
      lastJson = json;
      void saveWorkspace(key, value);
    }, delayMs);
  };
}
