# 🦞 爪爪 ClawBot AI —— 微信个人号机器人

基于 **Cloudflare Worker** + **Worker AI**，通过微信官方 **ClawBot / iLink** 协议接入你的微信个人号。

---

## ✨ 核心功能

| 功能 | 说明 | 依赖组件 |
| --- | --- | --- |
| 💬 AI 对话 | 微信发文字 → AI 自动回复（支持多轮上下文） | Worker AI |
| 🔐 扫码登录 | 官方 iLink 协议，凭证安全存储 | KV |
| 📊 管理面板 | 实时状态监控、AI 测试、手动拉取 | HTML |
| ⏰ 自动拉取 | Cron 定时触发，默认每 2 分钟 | Triggers |
| 📝 内置指令 | `帮助 / 重置 / 关于`，零 Token 消耗 | 本地逻辑 |
| 🧠 上下文 | 每用户独立，3 小时自动过期 | Cache API |
| 📜 长期历史 | 对话记录永久保留（可选） | R2 |
| 📈 统计分析 | 小时级聚合统计（可选） | D1 |
| 🚀 异步处理 | 消息入队，防止 cron 超时（可选） | Queues |

---

## 🚀 快速部署

### 基础部署（必需）

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 KV namespace（存储凭证）
npx wrangler kv:namespace create CLAWBOT_KV
# 把输出的 id 填入 wrangler.toml 的 [[kv_namespaces]]

# 4. ⚠️ 设置管理员密码（必需）
npx wrangler secret put ADMIN_PASSWORD

# 5. 部署
npm run deploy
```

### 可选增强（推荐）

```bash
# 统计数据库（D1）
npx wrangler d1 create clawbot-stats
npx wrangler d1 execute clawbot-stats --file=./schema.sql

# 异步消息队列（Queues）—— 防止 cron 超时
npx wrangler queues create clawbot-messages

# 长期对话历史（R2）—— 永久存储
npx wrangler r2 bucket create clawbot-history

# AI 模型自定义
npx wrangler secret put AI_MODEL
# 可用：@cf/meta/llama-3-8b-instruct, @cf/mistral/mistral-7b-instruct-v0.1 等

# 自定义人设
npx wrangler secret put AI_SYSTEM_PROMPT
```

### 配置文件

修改 `wrangler.toml` 填入你的资源 ID：

```toml
[[kv_namespaces]]
binding = "CLAWBOT_KV"
id = "你的 KV ID"

[[d1_databases]]
binding = "CLAWBOT_DB"
database_name = "clawbot-stats"
database_id = "你的 D1 ID"

[[r2_buckets]]
binding = "CLAWBOT_R2"
bucket_name = "clawbot-history"

[[queues.producers]]
binding = "CLAWBOT_QUEUE"
queue = "clawbot-messages"

[[queues.consumers]]
queue = "clawbot-messages"
max_batch_size = 10
```

---

## 📱 扫码绑定微信

1. 打开 `https://<你的 Worker 域名>/login`（需输入管理员密码）
2. 在微信里：`我 → 设置 → 插件 → ClawBot`
3. 用微信扫描页面上的二维码
4. 手机上点确认 → 页面提示"登录成功" → 自动跳回首页
5. 完成 ✅

---

## 💬 微信指令

| 指令 | 效果 | 说明 |
| --- | --- | --- |
| `帮助` / `help` | 显示使用指南 | 不调用 AI |
| `重置` / `clear` | 清空对话上下文 | 不调用 AI |
| `关于` / `about` | 版本信息 | 不调用 AI |
| `你好` / `时间` / `谢谢` | 快捷回复 | 零 Token 消耗 |
| 其他文字 | AI 自动回答 | 走 Worker AI |

---

## 🌐 路由一览

| 方法 | 路径 | 用途 | 权限 |
| --- | --- | --- | --- |
| GET | `/` | 管理面板（状态 + 聊天测试） | 公开 |
| GET | `/login` | 扫码登录页 | ✅ 需密码 |
| GET | `/api/qrcode` | 申请新二维码 | ✅ 需密码 |
| GET | `/api/qrcode-status` | 轮询扫码状态 | ✅ 需密码 |
| POST | `/api/trigger-poll` | 手动触发消息拉取 | ✅ 需密码 |
| GET | `/api/status` | 实时状态 JSON | 公开 |
| GET | `/api/history` | D1 小时统计 | 公开 |
| GET | `/api/r2-history` | R2 对话历史 | ✅ 需密码 |
| POST | `/api/logout` | 退出登录 | ✅ 需密码 |
| POST | `/api/chat` | `{ message, userId }` → AI | 公开 |
| GET | `/healthz` | 健康检查 | 公开 |

### 密码访问方式

- **URL 参数**：`https://xxx.workers.dev/login?pwd=你的密码`
- **Basic Auth**：`Authorization: Basic base64(admin:你的密码)`
- **登录页**：页面内自带密码输入框

---

## ⚙️ 环境变量配置

### 必需配置（必须设置）

| 配置项 | 说明 | 设置命令 |
| --- | --- | --- |
| **ADMIN_PASSWORD** | 管理接口密码（保护登录、设置等敏感功能） | `wrangler secret put ADMIN_PASSWORD` |

### 可选配置（可在管理面板设置）

| 配置项 | 说明 | 默认值 | 设置方式 |
| --- | --- | --- | --- |
| `AI_MODEL` | Worker AI 模型名称 | `@cf/meta/llama-3-8b-instruct` | 管理面板 / `wrangler secret put AI_MODEL` |
| `AI_SYSTEM_PROMPT` | AI 人设提示词 | `你是爪爪，一个友好的 AI 助手...` | 管理面板 / `wrangler secret put AI_SYSTEM_PROMPT` |
| `TURNSTILE_SITE_KEY` | Turnstile 人机验证公钥 | 空（不启用） | 管理面板 / `wrangler.toml` 的 `[vars]` |
| `TURNSTILE_SECRET_KEY` | Turnstile 人机验证私钥 | 空（不启用） | `wrangler secret put TURNSTILE_SECRET_KEY` |

### 配置优先级

1. **环境变量 / Secret**（优先级最高）
   - 通过 `wrangler secret put` 设置的 Secret 会覆盖管理面板的配置
   - 适合需要通过 CI/CD 部署或版本控制管理的场景

2. **管理面板设置**（保存在 KV）
   - 在管理面板修改后即时生效，无需重新部署
   - 适合运行时动态调整配置
   - 若环境变量未设置，则使用管理面板的值

### 常用 AI 模型

| 模型名称 | 说明 |
| --- | --- |
| `@cf/meta/llama-3-8b-instruct` | Llama 3 8B（默认，平衡性能与效果） |
| `@cf/meta/llama-3-70b-instruct` | Llama 3 70B（更强大，但延迟更高） |
| `@cf/mistral/mistral-7b-instruct-v0.1` | Mistral 7B（轻量级，响应快） |
| `@cf/baichuan-inc/Baichuan2-7B-Chat` | 百川 7B（中文优化） |

> **提示**：`ADMIN_PASSWORD` 必须通过 `wrangler secret put` 设置，无法在管理面板中修改。其他配置推荐在管理面板中设置，方便随时调整。

---

## 📊 管理面板

访问 `https://<你的域名>/` 查看：

- **实时状态**：轮询次数、AI 调用、错误统计
- **历史统计**：过去 24 小时 / 7 天数据
- **AI 测试**：直接对话测试（公开）
- **R2 历史**：查询用户对话记录（需密码）
- **系统设置**：配置 AI 模型、人设提示词、Turnstile（需密码）

---

## 🏗️ 架构

```
微信用户 → 微信服务器 (ilinkai.weixin.qq.com)
                          ↑
                          │ HTTP POST getupdates / sendmessage
                          │
                 ┌─────────────────────────────────────────────────┐
                 │           Cloudflare Worker (本项目)            │
                 └─────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┬─────────────────┐
        ▼                 ▼                 ▼                 ▼
   Worker AI           KV (凭证)       Cache API       D1 + R2
  (Llama 3 8B)        (bot_token)    (上下文/去重)  (统计/历史)
        │                                        │
        └────────────────────────────────────────┘
                          │
                          ▼
                    Queues (异步)
```

### 存储方案对比

| 数据类型 | 存储方式 | TTL | 成本 |
| --- | --- | --- | --- |
| 凭证 | KV | 永久 | 低（生命周期写 1 次） |
| 对话上下文 | Cache API | 3 小时 | 免费 |
| AI 回复缓存 | Cache API | 12 小时 | 免费 |
| 消息去重 | Cache API | 2 小时 | 免费 |
| 统计数据 | D1 | 永久 | 低（每小时 1 条） |
| 长期历史 | R2 | 永久 | 低（按需） |

---

## 📁 文件结构

```
.
├── wrangler.toml          # Cloudflare 配置（KV/D1/R2/Queues）
├── schema.sql             # D1 数据库 schema
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           # 主入口：路由、Cron、Queue 消费者、管理面板
    ├── ilink.ts           # iLink 协议：扫码、拉消息、发消息、文本格式化
    └── ai-service.ts      # AI 服务：上下文管理、敏感词过滤、缓存、R2 写入
```

---

## 📊 管理面板

访问 `https://<你的域名>/` 查看：

- **实时状态**：轮询次数、AI 调用、错误统计
- **历史统计**：过去 24 小时 / 7 天数据
- **AI 测试**：直接对话测试（公开）
- **R2 历史**：查询用户对话记录（需密码）

---

## ❓ 常见问题

**Q: 消息延迟多久？**

A: Cron 默认每 2 分钟跑一次，最多约 2 分钟延迟。配置 Queues 后更可靠。

**Q: 微信 ClawBot 需要手机端一直在后台吗？**

A: 不需要。iLink 协议走微信服务器，和手机是否在线无关。

**Q: 支持群聊吗？**

A: iLink 协议主要面向私聊，群聊支持视微信策略而定。

**Q: 可以换成别的 AI 模型吗？**

A: 可以。通过 `AI_MODEL` 环境变量设置，支持 Worker AI 的所有模型。

**Q: 免费额度够用吗？**

A: 完全够用。Cache API 代替 KV 后，写入几乎为零；D1 每小时只写 1 条。

---

## 📝 更新日志

### v1.5 Cloudflare Suite（最新）

- ✅ 管理员密码 **必需**（保护敏感接口）
- ✅ 集成 Cloudflare Queues — 异步消息处理
- ✅ 集成 R2 — 长期对话历史存储
- ✅ 集成 Turnstile — 防机器人（可选）
- ✅ AI 模型可配置（通过 `AI_MODEL` 环境变量）
- ✅ 管理面板全面升级

### v1.4 D1 统计

- ✅ D1 数据库集成
- ✅ 小时级聚合统计
- ✅ 错误环形日志

### v1.3 Cache API 优化

- ✅ Cache API 替代 KV（上下文/去重/缓存）
- ✅ 零 KV 高频写
- ✅ AI 回复 12h 缓存

### v1.2 基础功能

- ✅ 微信 iLink 协议接入
- ✅ Worker AI 对话
- ✅ 扫码登录
- ✅ 管理面板
- ✅ Cron 自动拉取

---

## 📜 许可证

MIT License