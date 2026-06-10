# 🦞 爪爪 ClawBot AI —— 微信个人号机器人

基于 **Cloudflare Worker** + **Worker AI**，通过微信官方 **ClawBot / iLink** 协议接入你的微信个人号，实现：

- ✅ 微信发文字 → AI 自动回复（支持多轮对话上下文）
- ✅ 扫码登录、凭证存储在 KV
- ✅ 网页管理面板：状态监控、AI 测试、手动拉取
- ✅ JSON API：`POST /api/chat` 直接调 AI
- ✅ Cron：每分钟自动拉取并处理新消息
- ✅ 内置指令：`帮助 / 重置 / 关于`
- ✅ 每用户独立上下文，3 小时自动过期（KV TTL）

使用的 AI 模型：`@cf/meta/llama-3-8b-instruct`

## 快速部署

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 KV namespace（首次）
npx wrangler kv:namespace create CLAWBOT_KV
# 把输出的 id 填入 wrangler.toml 的 [[kv_namespaces]]

# 4. 部署
npm run deploy
```

部署成功后，Cloudflare 会给你一个 Worker URL，例如：
```
https://wechat-clawbot-ai.xxx.workers.dev
```

## 扫码绑定微信

1. 打开 `https://<你的域名>/login`
2. 在微信里：`我 → 设置 → 插件 → ClawBot`
3. 用微信扫描页面上的二维码
4. 手机上点确认 → 页面提示“登录成功” → 自动跳回首页
5. 完成 ✅

现在别人在微信跟你对话，你可以在 `/`（首页）点击「手动触发一次拉取」来立即处理消息。
Worker 也会按 cron（默认每分钟）自动拉取，处理后回复给微信用户。

## 微信指令

在微信里直接发消息：

- `帮助` 或 `help` —— 显示使用指南
- `重置` 或 `clear` —— 清空你的对话上下文
- `关于` 或 `about` —— 机器人版本信息
- 其他文字 —— AI 自动回答

## 路由一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET  | `/`                | 管理面板（状态 + 聊天测试） |
| GET  | `/login`           | 扫码登录页 |
| GET  | `/api/qrcode`      | 向微信申请新二维码 |
| GET  | `/api/qrcode-status` | 轮询扫码状态，成功后保存凭证 |
| POST | `/api/trigger-poll`| 手动触发一次消息拉取与 AI 回复 |
| GET  | `/api/status`      | 状态信息 |
| POST | `/api/logout`      | 退出登录、清除凭证 |
| POST | `/api/chat`        | `{ message, userId }` → 直接调 AI |
| GET  | `/healthz`         | 健康检查 |

## 安全配置（建议）

在 `wrangler.toml` 或 secret 里设置 `ADMIN_PASSWORD`，这样 `/login`、`/api/trigger-poll` 等管理路径会要求密码。

```bash
wrangler secret put ADMIN_PASSWORD
```

然后在访问时用 `?pw=密码` 或在请求头加 `Authorization: Bearer 密码`。

## 架构

```
微信用户 → 微信服务器 (ilinkai.weixin.qq.com)
                          ↑
                          │ HTTP POST getupdates / sendmessage
                          │
                 Cloudflare Worker (本项目)
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
         Worker AI (Llama 3)    KV 存储 (凭证 + 上下文)
```

- Worker 用 `getupdates` 短轮询微信服务器拉取新消息（3~5 秒 / 次，由 cron 每分钟触发）
- 用户文本消息 → 指令检测 → AI 回答 → `sendmessage` 回复
- 每用户的对话上下文独立保存，3 小时自动过期

## 文件结构

```
.
├── wrangler.toml          # Cloudflare 配置
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           # Worker 主入口 + 路由 + HTML 面板
    ├── ilink.ts           # 微信 iLink 协议客户端 (扫码/发消息/拉消息)
    └── ai-service.ts      # Worker AI 对话服务 + KV 上下文管理
```

## 常见问题

**Q: 消息延迟多久？**
A: cron 默认 1 分钟跑一次，所以最多约 1 分钟延迟。如果你希望更实时，可以 `wrangler dev` 本地轮询，或者 `/api/trigger-poll` 手动触发。

**Q: 微信 ClawBot 需要手机端一直在后台吗？**
A: 不需要。iLink 协议是走微信服务器，和手机是否在线无关。

**Q: 支持群聊吗？**
A: iLink 协议的私聊已经稳定；群聊是否支持视微信当前版本策略。当前版本主要面向个人私信。

**Q: 可以换成别的 AI 模型吗？**
A: 可以。在 `src/ai-service.ts` 修改 `DEFAULT_MODEL`，或在 `wrangler.toml` 里设置 `AI_SYSTEM_PROMPT` 调整机器人人设。
