// @ts-nocheck
// biome-ignore-all lint: legacy queue implementation kept as-is

export class AsyncQueue {
  private queue: Array<[() => Promise<unknown>, (v: any) => void, (v: string) => void]> = [];
  private isRunning = false;

  public async enqueue<T>(callback: () => Promise<T>, autostart = true): Promise<T> {
    return new Promise((res, rej) => {
      this.queue.push([callback, res, rej]);
      if (!this.isRunning && autostart) {
        this.start();
      }
    });
  }

  private run() {
    if (!this.queue.length) {
      this.done();
      return;
    }

    const curr = this.queue.splice(0, 1)[0];

    curr[0]()
      .then((r) => {
        curr[1](r);
        this.run();
      })
      .catch((e) => {
        curr[2](e);
        this.run();
      });
  }

  private done() {
    this.isRunning = false;
  }

  public start() {
    this.isRunning = true;
    this.run();
  }

  public get enqueued(): number {
    return this.queue.length;
  }
}
