export class InboundTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.tails.set(key, current);

    void current
      .finally(() => {
        if (this.tails.get(key) === current) {
          this.tails.delete(key);
        }
      })
      .catch(() => undefined);

    return current;
  }
}
