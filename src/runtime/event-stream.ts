/**
 * EventStream — 异步可迭代的推拉混合通道。
 *
 * 设计模式：生产者-消费者 + Go Channel + Async Iterator
 *   - 生产者：push(event) 推入事件
 *   - 消费者：for await...of 拉取事件
 *   - 缓冲区：吸收生产/消费速率差异
 *
 * 对比 subscribe/emit（观察者模式）：
 *   subscribe/emit  = 1:N 广播，消费者被动接收
 *   EventStream     = 1:1 管道，消费者主动拉取
 *
 * 两者配合使用：
 *   EventStream 处理单条管道 → 消费后 emit 广播给 subscribe 订阅者
 */
export class EventStream<T, R = void> implements AsyncIterable<T> {
  /** 内部缓冲区：生产者快于消费者时暂存 */
  private queue: T[] = [];

  /** 挂起的消费者：消费者快于生产者时暂存 resolve */
  private waiting: Array<(value: IteratorResult<T>) => void> = [];

  /** 流是否已结束 */
  private done = false;

  /** 最终结果 Promise */
  private resultPromise: Promise<R>;
  private resolveResult!: (result: R) => void;

  /** 判断事件是否为终止事件 */
  private isComplete: (event: T) => boolean;

  /** 从终止事件提取最终结果 */
  private extractResult: (event: T) => R;

  constructor(
    isComplete: (event: T) => boolean,
    extractResult: (event: T) => R,
  ) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.resultPromise = new Promise((resolve) => {
      // 保存 resolve 函数，以便在流结束时调用
      this.resolveResult = resolve;
    });
  }

  /** 生产者推送事件 */
  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  /** 强制结束流 */
  end(result?: R): void {
    this.done = true;
    if (result !== undefined) this.resolveResult(result);
    while (this.waiting.length > 0) {
      this.waiting.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  /** 等待最终结果（流结束后才 resolve） */
  result(): Promise<R> {
    return this.resultPromise;
  }

  /** 实现 AsyncIterable，供 for await...of 消费 */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
    }
  }
}
