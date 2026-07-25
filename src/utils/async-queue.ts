export class AsyncQueue {
  private queue: Array<() => Promise<void>> = [];
  private isRunning = false;

  public enqueue<T>(callback: () => Promise<T>, autostart = true): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await callback());
        } catch (error) {
          reject(error);
        }
      });

      if (!this.isRunning && autostart) {
        this.start();
      }
    });
  }

  private async run(): Promise<void> {
    let callback = this.queue.shift();
    while (callback !== undefined) {
      await callback();
      callback = this.queue.shift();
    }

    this.isRunning = false;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    void this.run();
  }

  public get enqueued(): number {
    return this.queue.length;
  }
}
