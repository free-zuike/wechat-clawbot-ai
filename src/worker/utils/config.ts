// 配置管理模块

import { Logger, ClawBotError } from "./error";
import { Validator } from "./security";

export interface ClawBotConfig {
  // AI 配置
  aiModel: string;
  aiSystemPrompt: string;
  aiMaxTokens: number;
  aiTemperature: number;
  
  // 服务配置
  adminPassword: string;
  baseUrl: string;
  port: number;
  
  // iLink 配置
  channelVersion: string;
  longPollTimeoutMs: number;
  apiTimeoutMs: number;
  
  // 缓存配置
  cacheTTL: number;
  
  // 限流配置
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  
  // 日志配置
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  
  // 安全配置
  sessionDurationHours: number;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

export class ConfigManager {
  private config: Partial<ClawBotConfig> = {};
  private defaults: ClawBotConfig = {
    aiModel: '@cf/meta/llama-3.2-3b-instruct',
    aiSystemPrompt: '你是一个智能助手，请用友好、专业的语言回答用户问题。',
    aiMaxTokens: 2048,
    aiTemperature: 0.7,
    adminPassword: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    port: 8080,
    channelVersion: 'weixin-ilink/0.1.0',
    longPollTimeoutMs: 35000,
    apiTimeoutMs: 15000,
    cacheTTL: 60,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 100,
    logLevel: 'info',
    sessionDurationHours: 24,
  };

  loadFromEnv(env: Record<string, string | undefined>): void {
    this.config = { ...this.defaults };
    
    // AI 配置
    if (env.AI_MODEL) this.config.aiModel = env.AI_MODEL;
    if (env.AI_SYSTEM_PROMPT) this.config.aiSystemPrompt = env.AI_SYSTEM_PROMPT;
    if (env.AI_MAX_TOKENS) this.config.aiMaxTokens = parseInt(env.AI_MAX_TOKENS, 10);
    if (env.AI_TEMPERATURE) this.config.aiTemperature = parseFloat(env.AI_TEMPERATURE);
    
    // 服务配置
    if (env.ADMIN_PASSWORD) this.config.adminPassword = env.ADMIN_PASSWORD;
    if (env.BASE_URL) this.config.baseUrl = env.BASE_URL;
    if (env.PORT) this.config.port = parseInt(env.PORT, 10);
    
    // iLink 配置
    if (env.CHANNEL_VERSION) this.config.channelVersion = env.CHANNEL_VERSION;
    if (env.LONG_POLL_TIMEOUT_MS) this.config.longPollTimeoutMs = parseInt(env.LONG_POLL_TIMEOUT_MS, 10);
    if (env.API_TIMEOUT_MS) this.config.apiTimeoutMs = parseInt(env.API_TIMEOUT_MS, 10);
    
    // 缓存配置
    if (env.CACHE_TTL) this.config.cacheTTL = parseInt(env.CACHE_TTL, 10);
    
    // 限流配置
    if (env.RATE_LIMIT_WINDOW_MS) this.config.rateLimitWindowMs = parseInt(env.RATE_LIMIT_WINDOW_MS, 10);
    if (env.RATE_LIMIT_MAX_REQUESTS) this.config.rateLimitMaxRequests = parseInt(env.RATE_LIMIT_MAX_REQUESTS, 10);
    
    // 日志配置
    if (env.LOG_LEVEL) {
      const levels: ClawBotConfig['logLevel'][] = ['debug', 'info', 'warn', 'error'];
      if (levels.includes(env.LOG_LEVEL as ClawBotConfig['logLevel'])) {
        this.config.logLevel = env.LOG_LEVEL as ClawBotConfig['logLevel'];
      }
    }
    
    // 安全配置
    if (env.SESSION_DURATION_HOURS) this.config.sessionDurationHours = parseInt(env.SESSION_DURATION_HOURS, 10);
    
    Logger.info('[Config] Loaded configuration from environment');
  }

  get<K extends keyof ClawBotConfig>(key: K): ClawBotConfig[K] {
    return this.config[key] as ClawBotConfig[K];
  }

  getAll(): ClawBotConfig {
    return this.config as ClawBotConfig;
  }

  set<K extends keyof ClawBotConfig>(key: K, value: ClawBotConfig[K]): void {
    this.config[key] = value;
    Logger.debug('[Config] Updated config', { key, value: this.sanitizeValue(key, value) });
  }

  validate(): ConfigValidationResult {
    const errors: string[] = [];
    const config = this.config as ClawBotConfig;
    
    try {
      Validator.string(config.aiModel, 'AI_MODEL');
      Validator.string(config.aiSystemPrompt, 'AI_SYSTEM_PROMPT');
      Validator.number(config.aiMaxTokens, 'AI_MAX_TOKENS');
      Validator.number(config.aiTemperature, 'AI_TEMPERATURE');
      Validator.url(config.baseUrl, 'BASE_URL');
      Validator.number(config.port, 'PORT');
      Validator.number(config.longPollTimeoutMs, 'LONG_POLL_TIMEOUT_MS');
      Validator.number(config.apiTimeoutMs, 'API_TIMEOUT_MS');
      Validator.number(config.cacheTTL, 'CACHE_TTL');
      Validator.number(config.rateLimitWindowMs, 'RATE_LIMIT_WINDOW_MS');
      Validator.number(config.rateLimitMaxRequests, 'RATE_LIMIT_MAX_REQUESTS');
      Validator.inArray(config.logLevel, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error']);
      Validator.number(config.sessionDurationHours, 'SESSION_DURATION_HOURS');
    } catch (e) {
      if (e instanceof ClawBotError) {
        errors.push(e.message);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  private sanitizeValue<K extends keyof ClawBotConfig>(key: K, value: ClawBotConfig[K]): ClawBotConfig[K] {
    if (key === 'adminPassword') {
      return '***' as ClawBotConfig[K];
    }
    return value;
  }

  async saveToKV(kv: KVNamespace): Promise<void> {
    try {
      await kv.put('clawbot:config', JSON.stringify(this.config));
      Logger.info('[Config] Saved configuration to KV');
    } catch (error) {
      Logger.error('[Config] Error saving config to KV', { error: (error as Error).message });
      throw new ClawBotError('CONFIG_SAVE_ERROR', 'Failed to save config', 500);
    }
  }

  async loadFromKV(kv: KVNamespace): Promise<void> {
    try {
      const stored = await kv.get('clawbot:config');
      if (stored) {
        this.config = { ...this.defaults, ...JSON.parse(stored) };
        Logger.info('[Config] Loaded configuration from KV');
      }
    } catch (error) {
      Logger.warn('[Config] Error loading config from KV, using defaults', { error: (error as Error).message });
    }
  }
}

export const configManager = new ConfigManager();