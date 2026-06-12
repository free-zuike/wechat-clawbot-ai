// 国际化 (i18n) - 后端服务
// 支持中英文响应消息

export type Language = 'zh-CN' | 'en-US';

export interface I18nStrings {
  // 认证相关
  authRequired: string;
  authFailed: string;
  tokenExpired: string;
  
  // 错误信息
  networkError: string;
  serverError: string;
  rateLimited: string;
  invalidRequest: string;
  
  // 状态信息
  loggedIn: string;
  notLoggedIn: string;
  tokenValid: string;
  tokenInvalid: string;
  
  // 操作反馈
  saveSuccess: string;
  saveFailed: string;
  deleteSuccess: string;
  deleteFailed: string;
  
  // 消息处理
  messageReceived: string;
  messageProcessed: string;
  aiReply: string;
  
  // 通用
  loading: string;
  success: string;
  error: string;
  unknown: string;
}

const zhCN: I18nStrings = {
  authRequired: '请先登录',
  authFailed: '认证失败',
  tokenExpired: 'Token 已过期',
  
  networkError: '网络错误，请稍后重试',
  serverError: '服务器错误',
  rateLimited: '请求过于频繁，请稍后重试',
  invalidRequest: '无效的请求',
  
  loggedIn: '已登录',
  notLoggedIn: '未登录',
  tokenValid: 'Token 有效',
  tokenInvalid: 'Token 无效',
  
  saveSuccess: '保存成功',
  saveFailed: '保存失败',
  deleteSuccess: '删除成功',
  deleteFailed: '删除失败',
  
  messageReceived: '消息已接收',
  messageProcessed: '消息已处理',
  aiReply: 'AI 已回复',
  
  loading: '加载中...',
  success: '成功',
  error: '错误',
  unknown: '未知',
};

const enUS: I18nStrings = {
  authRequired: 'Please login first',
  authFailed: 'Authentication failed',
  tokenExpired: 'Token has expired',
  
  networkError: 'Network error, please try again',
  serverError: 'Server error',
  rateLimited: 'Rate limited, please try again later',
  invalidRequest: 'Invalid request',
  
  loggedIn: 'Logged in',
  notLoggedIn: 'Not logged in',
  tokenValid: 'Token valid',
  tokenInvalid: 'Token invalid',
  
  saveSuccess: 'Saved successfully',
  saveFailed: 'Failed to save',
  deleteSuccess: 'Deleted successfully',
  deleteFailed: 'Failed to delete',
  
  messageReceived: 'Message received',
  messageProcessed: 'Message processed',
  aiReply: 'AI replied',
  
  loading: 'Loading...',
  success: 'Success',
  error: 'Error',
  unknown: 'Unknown',
};

const translations: Record<Language, I18nStrings> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export class I18nService {
  private language: Language;

  constructor(language: Language = 'zh-CN') {
    this.language = language;
  }

  setLanguage(language: Language): void {
    this.language = language;
  }

  getLanguage(): Language {
    return this.language;
  }

  t(key: keyof I18nStrings): string {
    return translations[this.language][key] || key;
  }

  getAll(): I18nStrings {
    return translations[this.language];
  }

  // 从请求头检测语言
  static detectLanguage(request: Request): Language {
    const acceptLang = request.headers.get('Accept-Language') || '';
    if (acceptLang.toLowerCase().includes('en')) {
      return 'en-US';
    }
    return 'zh-CN';
  }

  // 从请求参数获取语言
  static getLanguageFromRequest(request: Request): Language {
    const url = new URL(request.url);
    const langParam = url.searchParams.get('lang');
    if (langParam === 'en') return 'en-US';
    if (langParam === 'zh') return 'zh-CN';
    return this.detectLanguage(request);
  }
}

export function createI18n(request?: Request): I18nService {
  if (request) {
    return new I18nService(I18nService.getLanguageFromRequest(request));
  }
  return new I18nService('zh-CN');
}

export function getMessage(key: keyof I18nStrings, lang: Language = 'zh-CN'): string {
  return translations[lang][key] || key;
}