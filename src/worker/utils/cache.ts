// 轻量级内存缓存 - 用于高频读取场景（如 status、config）
// 注意：Cloudflare Worker 内存缓存仅在同一实例存活期间有效，适合减轻 KV 读压力

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface CacheOptions {
  defaultTtlMs: number;
  maxEntries: number;
}

export class MemoryCache {
  private cache: Map<string, CacheEntry<any>>;
  private defaultTtlMs: number;
  private maxEntries: number;

  constructor(options: Partial<CacheOptions> = {}) {
    this.cache = new Map();
    this.defaultTtlMs = options.defaultTtlMs || 5000; // 默认 5 秒
    this.maxEntries = options.maxEntries || 100;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    // 超过容量时清理 20%
    if (this.cache.size >= this.maxEntries) {
      const entriesToDelete = Math.floor(this.maxEntries * 0.2);
      const keys = this.cache.keys();
      for (let i = 0; i < entriesToDelete; i++) {
        const next = keys.next();
        if (next.done) break;
        this.cache.delete(next.value);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs || this.defaultTtlMs),
    });
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs?: number
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) return cached;

    const value = await loader();
    if (value !== null && value !== undefined) {
      this.set(key, value, ttlMs);
    }
    return value;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// 全局缓存实例 - 不同用途可配置不同 TTL
export const statusCache = new MemoryCache({ defaultTtlMs: 3000, maxEntries: 50 });      // 状态缓存 3秒
export const configCache = new MemoryCache({ defaultTtlMs: 10000, maxEntries: 20 });      // 配置缓存 10秒
export const alertCache = new MemoryCache({ defaultTtlMs: 2000, maxEntries: 30 });         // 报警缓存 2秒
