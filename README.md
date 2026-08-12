# 🦞 ClawBot AI — 微信个人号 AI 机器人

基于 **Cloudflare Workers + Durable Objects + D1 + Worker AI + MCP**，通过微信官方 **iLink** 协议接入微信个人号，支持文字对话、图片/视频生成、MCP 工具调用（记账、笔记、邮件、推送等）。

---

## ✨ 功能一览

| 功能 | 说明 |
|------|------|
| 💬 AI 对话 | 微信发文字 → AI 自动回复（支持多轮上下文，最近 20 轮/3 天） |
| 🖼️ 图片生成 | `/图片 <描述>` 或 `/image <prompt>` → AI 生图 |
| 🎬 视频生成 | `/视频 <描述>` 或 `/video <prompt>` → AI 生视频 |
| 🔌 MCP 工具 | 接入任意 Streamable HTTP MCP 服务（记账、笔记、推送等），AI 自动调用 |
| 🗞️ 中文新闻 | 内置 `get_news` 工具，聚合微博/知乎/头条等中文热搜 |
| 📅 时间感知 | 内置 `get_current_datetime`，时区正确（Asia/Shanghai） |
| 💬 引用消息 | 支持识别微信引用消息，AI 可回复被引用内容 |
| 📊 管理面板 | AI 测试（Markdown 渲染）、MCP 管理、生成记录、视频任务 |
| 🔑 多密钥重试 | API 密钥失败自动切换备用密钥 |
| 🔐 扫码登录 | iLink 协议，凭证安全存储（支持多账号） |
| ⏰ 自动拉取 | Cron 每 2 分钟轮询微信消息 |
| 🚨 失败告警 | AI 调用失败自动通过 MCP 推送通知 |

---

## 🚀 快速开始（Fork 后部署）

```bash
# 1. Fork 仓库到你的 GitHub

# 2. 克隆到本地
git clone https://github.com/<你的用户名>/wechat-clawbot-ai.git
cd wechat-clawbot-ai

# 3. 安装依赖
npm install

# 4. 登录 Cloudflare
npx wrangler login

# 5. 创建必需资源
npx wrangler kv:namespace create CLAWBOT_KV    # 记录 id
npx wrangler d1 create clawbot-logs              # 记录 database_id
npx wrangler queues create clawbot-tasks         # 创建消息队列

# 6. 更新 wrangler.toml 中的 ID
#    - KV namespace id
#    - D1 database_id

# 7. 设置管理员密码
npx wrangler secret put ADMIN_PASSWORD

# 8. 部署
npm run build && npx wrangler deploy
```

> **注意**：Durable Object 迁移必须使用非版本化部署，`wrangler.toml` 已配置 `deployment.strategy = "all_at_once"`。

### 首次登录

1. 打开 `https://<你的 Worker 域名>/`
2. 输入管理员密码
3. 点击「微信绑定」→ 扫描二维码
4. 微信端确认 → 绑定完成

---

## 🔌 MCP 服务器配置

在管理后台「MCP Server 管理」中添加 **Streamable HTTP** 类型的 MCP 服务（`@modelcontextprotocol/sdk` 的 HTTP 传输，或任何暴露 `/mcp` 端点的服务）：

```
名称: 你的服务名
URL: https://example.com/mcp
API Key: （可选）
工具前缀: 自动生成，避免工具名冲突
```

**注意**：仅支持 Streamable HTTP 传输（标准 MCP HTTP 协议，Worker 可直接调用）。不支持 stdio 类型（需要本地运行 npx/node）的 MCP 服务器。

**特性**：
- 工具描述自动追加参数说明和服务名标签，帮助 AI 正确选择
- MCP 工具结果自动保存到上下文，支持"看第X条"等追问
- 支持多服务器同时接入，AI 按需路由

---

## 📦 项目结构

```
├── wrangler.toml              # Cloudflare Worker 配置
├── package.json               # 依赖和构建脚本
├── schema.sql                 # D1 数据库建表
├── src/worker/
│   ├── index.ts               # 主入口：路由、Cron、Queue 消费者
│   ├── services/
│   │   ├── ilink-do.ts        # Durable Object：iLink 连接、消息处理
│   │   ├── ilink-handlers.ts  # DO 路由处理器（已拆分）
│   │   ├── ilink-db.ts        # DO SQLite/D1 初始化与凭证管理
│   │   ├── ilink.ts           # iLink 协议：扫码、拉消息、发消息
│   │   ├── ai.ts              # AI 服务 + 内置工具（时间、新闻）
│   │   ├── mcp.ts             # MCP 客户端（工具发现、会话、调用）
│   │   ├── context.ts         # 对话上下文管理（D1 + DO SQLite）
│   │   ├── cdn-upload.ts      # CDN 媒体上传
│   │   └── webhook.ts         # Webhook 通知（带重试）
│   ├── routes/
│   │   ├── admin.ts           # 管理后台 API
│   │   ├── chat.ts            # AI 测试聊天
│   │   ├── config.ts          # 配置管理
│   │   ├── mcp.ts             # MCP 服务器管理 API
│   │   └── do.ts              # DO 代理路由
│   └── types/                 # TypeScript 类型定义
└── web/src/
    ├── views/
    │   ├── AdminPage.vue      # 管理后台主页
    │   └── LoginPage.vue      # 登录页
    └── components/admin/
        ├── ChatPanel.vue      # AI 测试聊天（Markdown 渲染、引用、编辑）
        ├── ConfigPanel.vue    # 系统配置（多提供商、上下文长度）
        ├── MCPServerPanel.vue # MCP 服务器管理
        ├── GenerationLogsPanel.vue  # 生成记录
        ├── PendingVideosPanel.vue   # 视频任务管理
        └── ...                # 其他面板
```

---

## ⚙️ 存储架构

| 表/存储 | 存储位置 | 内容 | 持久性 |
|---------|---------|------|--------|
| `generation_logs` | **D1** | 生成记录（文字/图片/视频） | ✅ 永久 |
| `pending_videos` | **D1** | 视频任务队列 | ✅ 永久 |
| `contexts` | **D1**（优先）/ DO SQLite | 对话上下文 | ✅ D1 永久 |
| `processed_messages` | **D1** / DO SQLite | 消息去重 | ✅ |
| `credentials` | DO SQLite / **D1** | iLink 凭证（多账号） | ✅ |
| `mcp_servers` | **D1** | MCP 服务器配置 | ✅ 永久 |
| `mcp_sessions` | **D1** | MCP 会话状态 | ✅ 永久 |
| 配置/密钥 | **KV** | AI 配置、Admin 密码 | ✅ 永久 |

---

## 🛠️ 构建与部署

```bash
# 开发模式（前端热重载）
npm run dev

# 构建前端到 dist/
npm run build

# 构建并部署
npm run deploy

# 仅部署（已构建）
npx wrangler deploy

# 查看实时日志
npx wrangler tail
```

### Cloudflare Dashboard 部署

如果通过 Cloudflare Dashboard 的 Git 集成部署：
- **构建命令**：`npm ci && npm run build`
- **输出目录**：`dist`
- **Node.js 版本**：18+

---

## 💬 微信指令

| 指令 | 说明 |
|------|------|
| `/图片 <描述>` 或 `/image <prompt>` | 生成图片 |
| `/视频 <描述>` 或 `/video <prompt>` | 生成视频 |
| `重置` / `reset` / `清空` | 清空对话上下文 |
| `帮助` / `about` | 使用帮助 |
| 其他文字 | AI 自动回复（可调用 MCP 工具） |

---

## 🌐 管理面板

访问 `https://<你的域名>/`：

| 页面 | 功能 |
|------|------|
| 📊 状态监控 | 轮询状态、账号信息 |
| 🎯 操作面板 | 手动拉取、微信绑定、WebSocket 实时消息 |
| ⚙️ 系统配置 | AI 提供商、密钥、模型、上下文长度、人设提示词 |
| 🔌 MCP 管理 | MCP 服务器增删改查、工具列表、连接测试 |
| 🤖 AI 测试 | 直接对话测试（支持 Markdown、引用、编辑） |
| 📝 生成记录 | 文字/图片/视频历史，含提供商、密钥序号、来源 |
| 🎬 视频任务 | 视频生成队列状态，含视频预览 |
| 🚨 报警中心 | 系统错误监控 |

---

## 📜 更新日志

### v2.1（当前）

- 🔌 **MCP 支持**：接入任意 Streamable HTTP MCP 服务器，AI 自动调用工具
- 🗞️ **中文新闻**：内置 `get_news` 工具，聚合微博/知乎/头条等热点
- 📅 **时间感知**：内置 `get_current_datetime`，正确处理中国时区
- 💬 **引用消息**：识别微信引用，AI 可回复被引用内容（含图片引用→以图生图/视频）
- 🧠 **上下文增强**：保存 MCP 工具结果，支持"看第X条"追问；最多 20 轮/3 天
- 🎨 **Markdown 渲染**：AI 测试聊天完整支持表格/列表/代码块/标题等
- 🛡️ **协议修复**：MCP 协议版本自适应、串行调用防冲突
- 🚨 **失败告警**：AI 调用失败自动通过 MCP 推送通知
- 🔑 **多账号**：支持多个微信账号同时在线

### v2.0

- 🔄 架构重构：Durable Object + D1 持久化
- 🖼️ 图片生成：支持 Agnes AI、智谱 CogView 等多家提供商
- 🎬 视频生成：支持 Agnes AI、智谱 CogVideoX
- 🔑 多密钥重试：API 密钥失败自动切换备用密钥
- 📝 生成记录：D1 永久存储，含提供商名称、密钥序号、来源
- 💬 引用功能：AI 测试聊天支持消息引用
- 🗑️ 消息管理：支持单条删除、清空聊天
- 📱 微信指令：`/图片`、`/image`、`/视频`、`/video`
- 🔐 安全加固：移除 URL 参数传密码

---

## 📜 许可证

MIT License