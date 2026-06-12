// 国际化 (i18n) - 中英文支持

export type Language = 'zh-CN' | 'en-US';

export interface I18nStrings {
  // 通用
  loading: string;
  error: string;
  success: string;
  save: string;
  cancel: string;
  confirm: string;
  delete: string;
  
  // 登录
  login: string;
  loginSuccess: string;
  loginFailed: string;
  pleaseLogin: string;
  logout: string;
  logoutSuccess: string;
  
  // 状态监控
  statusMonitor: string;
  loggedIn: string;
  notLoggedIn: string;
  loginDuration: string;
  tokenStatus: string;
  valid: string;
  invalid: string;
  expired: string;
  totalPolls: string;
  totalHandled: string;
  totalAICalls: string;
  totalAIFails: string;
  lastLatency: string;
  lastPollTime: string;
  
  // 消息控制
  messageControl: string;
  triggerPoll: string;
  polling: string;
  pollComplete: string;
  pollFailed: string;
  
  // 系统配置
  systemConfig: string;
  aiModel: string;
  aiPrompt: string;
  loadCurrentConfig: string;
  saveConfig: string;
  configSaved: string;
  configSaveFailed: string;
  
  // AI 测试
  aiTest: string;
  sendMessage: string;
  typeMessage: string;
  chat: string;
  
  // 调试
  debug: string;
  runDiagnostic: string;
  diagnosing: string;
  
  // 管理
  admin: string;
  sessionManagement: string;
  dataQuery: string;
  recentMessages: string;
  userSessions: string;
  stats: string;
  todayStats: string;
  weeklyStats: string;
  
  // 消息类型
  text: string;
  image: string;
  voice: string;
  file: string;
  video: string;
  
  // 错误消息
  networkError: string;
  serverError: string;
  unauthorized: string;
  rateLimited: string;
  
  // 导航
  statusMonitor: string;
  systemSettings: string;
  sessionManagement: string;
}

const zhCN: I18nStrings = {
  loading: '加载中...',
  error: '错误',
  success: '成功',
  save: '保存',
  cancel: '取消',
  confirm: '确认',
  delete: '删除',
  
  login: '登录',
  loginSuccess: '登录成功',
  loginFailed: '登录失败',
  pleaseLogin: '请先登录',
  logout: '退出登录',
  logoutSuccess: '已退出登录',
  
  statusMonitor: '状态监控',
  loggedIn: '✅ 在线',
  notLoggedIn: '❌ 未登录',
  loginDuration: '登录时长',
  tokenStatus: 'Token 状态',
  valid: '有效',
  invalid: '无效',
  expired: '已过期',
  totalPolls: '累计轮询',
  totalHandled: '累计处理',
  totalAICalls: 'AI 调用',
  totalAIFails: 'AI 失败',
  lastLatency: '上次耗时',
  lastPollTime: '最后轮询',
  
  messageControl: '消息控制',
  triggerPoll: '🔄 立即拉取消息',
  polling: '轮询中...',
  pollComplete: '轮询完成',
  pollFailed: '轮询失败',
  
  systemConfig: '系统配置',
  aiModel: 'AI 模型',
  aiPrompt: '人设提示词',
  loadCurrentConfig: '📥 加载当前配置',
  saveConfig: '💾 保存配置',
  configSaved: '✅ 配置已保存',
  configSaveFailed: '❌ 配置保存失败',
  
  aiTest: 'AI 测试聊天',
  sendMessage: '发送',
  typeMessage: '输入消息...',
  chat: '聊天',
  
  debug: '调试面板',
  runDiagnostic: '🔍 运行诊断',
  diagnosing: '诊断中...',
  
  admin: '管理后台',
  sessionManagement: '会话管理',
  dataQuery: '数据查询',
  recentMessages: '最近消息',
  userSessions: '用户会话',
  stats: '统计数据',
  todayStats: '今日统计',
  weeklyStats: '本周统计',
  
  text: '文本',
  image: '图片',
  voice: '语音',
  file: '文件',
  video: '视频',
  
  networkError: '网络错误，请检查连接',
  serverError: '服务器错误',
  unauthorized: '未授权访问',
  rateLimited: '请求过于频繁，请稍后重试',
  
  statusMonitor_short: '状态监控',
  systemSettings: '系统配置',
  sessionManagement_short: '会话管理',
};

const enUS: I18nStrings = {
  loading: 'Loading...',
  error: 'Error',
  success: 'Success',
  save: 'Save',
  cancel: 'Cancel',
  confirm: 'Confirm',
  delete: 'Delete',
  
  login: 'Login',
  loginSuccess: 'Login successful',
  loginFailed: 'Login failed',
  pleaseLogin: 'Please login first',
  logout: 'Logout',
  logoutSuccess: 'Logged out',
  
  statusMonitor: 'Status Monitor',
  loggedIn: '✅ Online',
  notLoggedIn: '❌ Not Logged In',
  loginDuration: 'Login Duration',
  tokenStatus: 'Token Status',
  valid: 'Valid',
  invalid: 'Invalid',
  expired: 'Expired',
  totalPolls: 'Total Polls',
  totalHandled: 'Total Handled',
  totalAICalls: 'AI Calls',
  totalAIFails: 'AI Fails',
  lastLatency: 'Last Latency',
  lastPollTime: 'Last Poll Time',
  
  messageControl: 'Message Control',
  triggerPoll: '🔄 Trigger Poll Now',
  polling: 'Polling...',
  pollComplete: 'Poll Complete',
  pollFailed: 'Poll Failed',
  
  systemConfig: 'System Config',
  aiModel: 'AI Model',
  aiPrompt: 'System Prompt',
  loadCurrentConfig: '📥 Load Current Config',
  saveConfig: '💾 Save Config',
  configSaved: '✅ Config Saved',
  configSaveFailed: '❌ Config Save Failed',
  
  aiTest: 'AI Test Chat',
  sendMessage: 'Send',
  typeMessage: 'Type a message...',
  chat: 'Chat',
  
  debug: 'Debug Panel',
  runDiagnostic: '🔍 Run Diagnostic',
  diagnosing: 'Diagnosing...',
  
  admin: 'Admin',
  sessionManagement: 'Session Management',
  dataQuery: 'Data Query',
  recentMessages: 'Recent Messages',
  userSessions: 'User Sessions',
  stats: 'Statistics',
  todayStats: "Today's Stats",
  weeklyStats: 'Weekly Stats',
  
  text: 'Text',
  image: 'Image',
  voice: 'Voice',
  file: 'File',
  video: 'Video',
  
  networkError: 'Network error, please check connection',
  serverError: 'Server error',
  unauthorized: 'Unauthorized access',
  rateLimited: 'Rate limited, please try again later',
  
  statusMonitor_short: 'Status',
  systemSettings: 'Config',
  sessionManagement_short: 'Sessions',
};

const translations: Record<Language, I18nStrings> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export class I18n {
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
}

// 单例模式
let instance: I18n | null = null;

export function getI18n(language?: Language): I18n {
  if (!instance) {
    instance = new I18n(language || 'zh-CN');
  }
  if (language) {
    instance.setLanguage(language);
  }
  return instance;
}

export function useT(key: keyof I18nStrings): string {
  return getI18n().t(key);
}