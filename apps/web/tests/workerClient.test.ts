import { describe, expect, it } from "vitest";
import { WorkerClient, type WorkerPort } from "../src/orchestrator/workerClient";
import type { FromWorker, Req } from "../src/workers/protocol";

type Methods = { echo: { params: { v: number }; result: number }; fail: { params: void; result: never } };

/** In-memory worker that answers asynchronously, possibly out of order. */
function fakeWorker(reply: (req: Req) => FromWorker | null) {
  const listeners: { message: ((ev: MessageEvent<FromWorker>) => void)[]; error: ((ev: ErrorEvent) => void)[] } = {
    message: [],
    error: [],
  };
  const port: WorkerPort = {
    postMessage(req) {
      const res = reply(req);
      if (res) setTimeout(() => listeners.message.forEach((fn) => fn({ data: res } as MessageEvent<FromWorker>)), 10 - req.id);
    },
    addEventListener(type: "message" | "error", fn: never) {
      (listeners[type] as unknown[]).push(fn);
    },
  };
  return { port, crash: (message: string) => listeners.error.forEach((fn) => fn({ message } as ErrorEvent)) };
}

describe("WorkerClient", () => {
  it("matches responses to requests by id even when they arrive out of order", async () => {
    const { port } = fakeWorker((req) => ({ kind: "res", id: req.id, ok: true, result: (req.params as { v: number }).v * 2 }));
    const client = new WorkerClient<Methods>(port);
    await expect(Promise.all([client.call("echo", { v: 1 }), client.call("echo", { v: 2 })])).resolves.toEqual([2, 4]);
  });

  it("rejects with the worker's error", async () => {
    const { port } = fakeWorker((req) => ({ kind: "res", id: req.id, ok: false, error: { code: "E-RND-001", message: "boom" } }));
    const client = new WorkerClient<Methods>(port);
    await expect(client.call("fail", undefined)).rejects.toEqual({ code: "E-RND-001", message: "boom" });
  });

  it("rejects all pending calls with E-WK-001 when the worker crashes", async () => {
    const { port, crash } = fakeWorker(() => null);
    const client = new WorkerClient<Methods>(port);
    const pending = client.call("echo", { v: 1 });
    crash("out of memory");
    await expect(pending).rejects.toEqual({ code: "E-WK-001", message: "out of memory" });
  });
});
