// 性能优化工具：缓存策略、消息队列、批量处理

import { Logger } from "./error";

// ========== 缓存策略 ==========
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class KVCache<T = any> {
  private kv: KVNamespace;
  private defaultTTL: number;

  constructor(kv: KVNamespace, defaultTTL: number = 60) {
    this.kv = kv;
    this.defaultTTL = defaultTTL;
  }

  async get(key: string): Promise<T | null> {
    try {
      const stored = await this.kv.get(key);
      if (!stored) return null;

      const entry: CacheEntry<T> = JSON.parse(stored);
      if (Date.now() > entry.timestamp + entry.ttl * 1000) {
        await this.kv.delete(key);
        return null;
      }

      return entry.data;
    } catch (error) {
      Logger.warn(`[Cache] Error getting key: ${key}`, { error: (error as Error).message });
      return null;
    }
  }

  async set(key: string, data: T, ttl?: number): Promise<void> {
    try {
      const entry: CacheEntry<T> = {
        data,
        timestamp: Date.now(),
        ttl: ttl || this.defaultTTL
      };
      await this.kv.put(key, JSON.stringify(entry), {
        expirationTtl: ttl || this.defaultTTL
      });
    } catch (error) {
      Logger.warn(`[Cache] Error setting key: ${key}`, { error: (error as Error).message });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.kv.delete(key);
    } catch (error) {
      Logger.warn(`[Cache] Error deleting key: ${key}`, { error: (error as Error).message });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const value = await this.kv.get(key);
      return value !== null;
    } catch {
      return false;
    }
  }
}

// ========== 消息队列（内存队列 + KV持久化）==========
interface QueueMessage<T> {
  id: string;
  data: T;
  timestamp: number;
  priority: number;
}

export class MessageQueue<T = any> {
  private queue: QueueMessage<T>[] = [];
  private kv: KVNamespace;
  private queueName: string;
  private maxSize: number;
  private persistenceKey: string;

  constructor(kv: KVNamespace, queueName: string, maxSize: number = 1000) {
    this.kv = kv;
    this.queueName = queueName;
    this.maxSize = maxSize;
    this.persistenceKey = `queue:${queueName}`;
  }

  async init(): Promise<void> {
    try {
      const stored = await this.kv.get(this.persistenceKey);
      if (stored) {
        this.queue = JSON.parse(stored);
        Logger.info(`[Queue] Loaded ${this.queue.length} messages from persistence`, { queue: this.queueName });
      }
    } catch (error) {
      Logger.warn(`[Queue] Error loading from persistence`, { error: (error as Error).message });
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.kv.put(this.persistenceKey, JSON.stringify(this.queue));
    } catch (error) {
      Logger.warn(`[Queue] Error persisting queue`, { error: (error as Error).message });
    }
  }

  async enqueue(data: T, priority: number = 0): Promise<string> {
    const id = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const message: QueueMessage<T> = { id, data, timestamp: Date.now(), priority };
    
    this.queue.push(message);
    this.queue.sort((a, b) => b.priority - a.priority);
    
    if (this.queue.length > this.maxSize) {
      this.queue = this.queue.slice(0, this.maxSize);
    }
    
    await this.persist();
    Logger.debug(`[Queue] Enqueued message`, { id, queue: this.queueName, size: this.queue.length });
    
    return id;
  }

  async dequeue(): Promise<T | null> {
    if (this.queue.length === 0) return null;
    
    const message = this.queue.shift()!;
    await this.persist();
    Logger.debug(`[Queue] Dequeued message`, { id: message.id, queue: this.queueName, size: this.queue.length });
    
    return message.data;
  }

  async peek(): Promise<T | null> {
    if (this.queue.length === 0) return null;
    return this.queue[0].data;
  }

  async size(): Promise<number> {
    return this.queue.length;
  }

  async clear(): Promise<void> {
    this.queue = [];
    await this.persist();
    Logger.info(`[Queue] Cleared all messages`, { queue: this.queueName });
  }

  async remove(id: string): Promise<boolean> {
    const index = this.queue.findIndex(m => m.id === id);
    if (index === -1) return false;
    
    this.queue.splice(index, 1);
    await this.persist();
    Logger.debug(`[Queue] Removed message`, { id, queue: this.queueName });
    
    return true;
  }

  async processBatch(batchSize: number = 10, processor: (items: T[]) => Promise<void>): Promise<number> {
    if (this.queue.length === 0) return 0;
    
    const batch = this.queue.slice(0, batchSize).map(m => m.data);
    this.queue = this.queue.slice(batchSize);
    
    try {
      await processor(batch);
      await this.persist();
      Logger.info(`[Queue] Processed batch of ${batch.length} messages`, { queue: this.queueName });
      return batch.length;
    } catch (error) {
      Logger.error(`[Queue] Error processing batch`, { error: (error as Error).message, queue: this.queueName });
      this.queue = [...batch.map((data, i) => ({ ...this.queue[i], data })), ...this.queue];
      await this.persist();
      throw error;
    }
  }
}

// ========== 批量处理器 ==========
export class BatchProcessor<T = any> {
  private items: T[] = [];
  private maxItems: number;
  private maxDelayMs: number;
  private processor: (items: T[]) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private name: string;

  constructor(name: string, processor: (items: T[]) => Promise<void>, options: { maxItems: number; maxDelayMs: number }) {
    this.name = name;
    this.processor = processor;
    this.maxItems = options.maxItems;
    this.maxDelayMs = options.maxDelayMs;
  }

  async add(item: T): Promise<void> {
    this.items.push(item);
    
    if (this.items.length >= this.maxItems) {
      await this.flush();
      return;
    }
    
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxDelayMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    
    if (this.items.length === 0) return;
    
    const items = [...this.items];
    this.items = [];
    
    try {
      Logger.debug(`[BatchProcessor] Processing ${items.length} items`, { name: this.name });
      await this.processor(items);
      Logger.debug(`[BatchProcessor] Completed processing`, { name: this.name });
    } catch (error) {
      Logger.error(`[BatchProcessor] Error processing batch`, { 
        name: this.name, 
        error: (error as Error).message 
      });
      throw error;
    }
  }

  async flushNow(): Promise<void> {
    await this.flush();
  }

  get pendingCount(): number {
    return this.items.length;
  }
}

// ========== 延迟执行工具 ==========
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  waitMs: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return function(this: unknown, ...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), waitMs);
  };
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  limitMs: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return function(this: unknown, ...args: Parameters<T>) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limitMs);
    }
  };
}