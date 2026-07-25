import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "./async-queue";

describe("AsyncQueue", () => {
  test("runs callbacks in FIFO order", async () => {
    const queue = new AsyncQueue();
    const events: string[] = [];
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = queue.enqueue(async () => {
      events.push("second");
      return 2;
    });

    expect(events).toEqual(["first:start"]);
    expect(queue.enqueued).toBe(1);

    releaseFirst();

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(queue.enqueued).toBe(0);
  });

  test("rejects the failed callback promise and continues draining", async () => {
    const queue = new AsyncQueue();
    const expectedError = new Error("expected failure");
    const failed = queue.enqueue(async () => {
      throw expectedError;
    });
    const subsequent = queue.enqueue(async () => "completed");

    await expect(failed).rejects.toBe(expectedError);
    expect(await subsequent).toBe("completed");
  });

  test("handles callbacks that throw synchronously", async () => {
    const queue = new AsyncQueue();
    const expectedError = new Error("synchronous failure");
    const failed = queue.enqueue(() => {
      throw expectedError;
    });

    await expect(failed).rejects.toBe(expectedError);
  });

  test("waits for start when autostart is disabled", async () => {
    const queue = new AsyncQueue();
    const events: string[] = [];
    const first = queue.enqueue(async () => {
      events.push("first");
      return 1;
    }, false);
    const second = queue.enqueue(async () => {
      events.push("second");
      return 2;
    }, false);

    await Promise.resolve();

    expect(events).toEqual([]);
    expect(queue.enqueued).toBe(2);

    queue.start();

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first", "second"]);
    expect(queue.enqueued).toBe(0);
  });
});
