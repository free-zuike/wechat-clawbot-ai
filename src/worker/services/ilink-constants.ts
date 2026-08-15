// iLink 协议常量（从 ilink.ts 拆出）

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CHANNEL_VERSION = "2.0.0";
export const DEFAULT_LONG_POLL_MS = 35000;
export const DEFAULT_API_MS = 15000;