import type { AppError, FromWorker, Req } from "../workers/protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: AppError) => void };

/** Minimal port the client needs; a Worker satisfies it (and so does a test fake). */
export interface WorkerPort {
  postMessage(msg: Req, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (ev: MessageEvent<FromWorker>) => void): void;
  addEventListener(type: "error", fn: (ev: ErrorEvent) => void): void;
}

/** Typed request/response wrapper around a Worker (detailed design 18.3). */
export class WorkerClient<M extends { [K in keyof M]: { params: unknown; result: unknown } }> {
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private port: WorkerPort) {
    port.addEventListener("message", (ev) => this.onMessage(ev.data));
    port.addEventListener("error", (ev) => {
      const error = { code: "E-WK-001", message: ev.message || "worker error" };
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
  }

  call<K extends keyof M & string>(method: K, params: M[K]["params"], transfer: Transferable[] = []): Promise<M[K]["result"]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ kind: "req", id, method, params }, transfer);
    });
  }

  private onMessage(msg: FromWorker) {
    if (msg.kind !== "res") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(msg.error);
  }
}
