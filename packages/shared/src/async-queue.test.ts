import { expect, test } from "bun:test";
import { AsyncQueue } from "./async-queue";

test("continues after a rejected task", async () => {
  const queue = new AsyncQueue();
  const failed = queue.enqueue(async () => Promise.reject(new Error("failed")));
  const succeeded = queue.enqueue(async () => "done");

  await expect(failed).rejects.toThrow("failed");
  await expect(succeeded).resolves.toBe("done");
});
