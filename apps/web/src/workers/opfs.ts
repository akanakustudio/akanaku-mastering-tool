// OPFS helpers for workers (detailed design 4.2). Safari only allows writes through sync
// access handles, which exist only in workers.

// The project compiles against the DOM lib, which leaves out these worker-only APIs.
export type SyncAccessHandle = {
  read(buffer: ArrayBufferView, options?: { at: number }): number;
  write(buffer: ArrayBufferView, options?: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
};
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };

export async function dir(path: string, create = true): Promise<FileSystemDirectoryHandle> {
  let d = await navigator.storage.getDirectory();
  for (const part of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

export async function openSync(path: string, create = true): Promise<SyncAccessHandle> {
  const parts = path.split("/");
  const d = await dir(parts.slice(0, -1).join("/"), create);
  const f = (await d.getFileHandle(parts[parts.length - 1], { create })) as SyncFileHandle;
  return f.createSyncAccessHandle();
}

const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Stores planar stereo float32 audio: all of L, then all of R. */
export async function writeStereo(path: string, left: Float32Array, right: Float32Array) {
  const h = await openSync(path);
  try {
    h.truncate(0);
    h.write(bytesOf(left), { at: 0 });
    h.write(bytesOf(right), { at: left.byteLength });
    h.flush();
  } finally {
    h.close();
  }
}

export async function readStereo(path: string): Promise<{ left: Float32Array; right: Float32Array }> {
  const h = await openSync(path, false);
  try {
    const frames = h.getSize() / 8;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    h.read(bytesOf(left), { at: 0 });
    h.read(bytesOf(right), { at: frames * 4 });
    return { left, right };
  } finally {
    h.close();
  }
}

export async function clearDir(path: string) {
  const d = await dir(path);
  const names: string[] = [];
  for await (const [name] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) names.push(name);
  for (const name of names) await d.removeEntry(name, { recursive: true });
}
