# 🦞 ClawBot AI — 微信个人号 AI 机器人

基于 **Cloudflare Workers + Durable Objects + D1 + Worker AI**，通过微信官方 **iLink** 协议接入微信个人号，支持文字对话、图片生成、视频生成。

---

## ✨ 功能一览

| 功能 | 说明 |
|------|------|
| 💬 AI 对话 | 微信发文字 → AI 自动回复（支持多轮上下文） |
| 🖼️ 图片生成 | `/图片 <描述>` 或 `/image <prompt>` → AI 生图 |
| 🎬 视频生成 | `/视频 <描述>` 或 `/video <prompt>` → AI 生视频 |
| 🔐 扫码登录 | iLink 协议，凭证安全存储 |
| 📊 管理面板 | AI 测试、生成记录、视频任务、配置管理 |
| 📝 生成记录 | 文字/图片/视频生成历史，含提供商、密钥、来源 |
| 🔑 多密钥重试 | API 密钥失败自动切换备用密钥 |
| ⏰ 自动拉取 | Cron 每 2 分钟轮询微信消息 |

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

### 首次登录

1. 打开 `https://<你的 Worker 域名>/`
2. 输入管理员密码
3. 点击「微信绑定」→ 扫描二维码
4. 微信端确认 → 绑定完成

---

## 📦 项目结构

```
├── wrangler.toml              # Cloudflare Worker 配置
├── package.json               # 依赖和构建脚本
├── migrations/
│   └── 0001_init.sql          # D1 数据库建表
├── src/worker/
│   ├── index.ts               # 主入口：路由、Cron、Queue 消费者
│   ├── utils.ts               # 工具函数：认证、JSON 辅助
│   ├── services/
│   │   ├── ilink-do.ts        # Durable Object：iLink 连接、消息处理、生成记录、视频任务
│   │   ├── ilink.ts           # iLink 协议：扫码、拉消息、发消息
│   │   ├── ai.ts              # AI 服务：图片/视频/文字生成、多密钥重试
│   │   ├── context.ts         # 对话上下文管理
│   │   ├── cdn-upload.ts      # CDN 媒体上传
│   │   └── webhook.ts         # Webhook 通知
│   ├── routes/
│   │   ├── admin.ts           # 管理后台 API
│   │   ├── chat.ts            # AI 测试聊天
│   │   ├── config.ts          # 配置管理
│   │   ├── do.ts              # DO 代理路由
│   │   └── ...                # 其他路由
│   └── types/                 # TypeScript 类型定义
└── web/src/
    ├── views/
    │   ├── AdminPage.vue      # 管理后台主页
    │   └── LoginPage.vue      # 登录页
    └── components/admin/
        ├── ChatPanel.vue      # AI 测试聊天（含引用、删除、持久化）
        ├── ConfigPanel.vue    # 系统配置（多密钥、提供商管理）
        ├── GenerationLogsPanel.vue  # 生成记录（含视频预览）
        ├── PendingVideosPanel.vue   # 视频任务管理（含视频预览）
        └── ...                # 其他面板
```

---

## ⚙️ 存储架构

| 表/存储 | 存储位置 | 内容 | 持久性 |
|---------|---------|------|--------|
| `generation_logs` | **D1** | 生成记录（文字/图片/视频） | ✅ 永久 |
| `pending_videos` | **D1** | 视频任务队列 | ✅ 永久 |
| `contexts` | DO SQLite | 对话上下文 | ❌ 部署后重置 |
| `processed_messages` | DO SQLite | 消息去重 | ❌ 部署后重置 |
| `credentials` | DO SQLite | iLink 凭证 | ❌ 部署后重置 |
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
| `重置` / `reset` | 清空对话上下文 |
| `帮助` / `about` | 使用帮助 |
| 其他文字 | AI 自动回复 |

---

## 🌐 管理面板

访问 `https://<你的域名>/`：

| 页面 | 功能 |
|------|------|
| 📊 状态监控 | 轮询状态、账号信息 |
| 🎯 操作面板 | 手动拉取、微信绑定、WebSocket |
| ⚙️ 系统配置 | AI 提供商、密钥、模型、人设提示词 |
| 🤖 AI 测试 | 直接对话测试（支持引用、删除） |
| 📝 生成记录 | 文字/图片/视频历史，含提供商、密钥序号、来源 |
| 🎬 视频任务 | 视频生成队列状态，含视频预览 |
| 🚨 报警中心 | 系统错误监控 |

---

## 📜 更新日志

### v2.0（当前）

- 🔄 **架构重构**：Durable Object + D1 持久化
- 🖼️ **图片生成**：支持 Agnes AI、智谱 CogView 等多家提供商
- 🎬 **视频生成**：支持 Agnes AI、智谱 CogVideoX
- 🔑 **多密钥重试**：API 密钥失败自动切换备用密钥
- 📝 **生成记录**：D1 永久存储，含提供商名称、密钥序号、来源
- 🎬 **视频预览**：生成记录和视频任务支持内嵌视频播放
- 💬 **引用功能**：AI 测试聊天支持消息引用（微信兼容格式）
- 🗑️ **消息管理**：支持单条删除、清空聊天
- 📱 **微信指令**：`/图片`、`/image`、`/视频`、`/video`
- 🏷️ **提供商名称**：所有界面显示提供商名称而非 ID
- 🔐 **安全加固**：移除 URL 参数传密码
- 🧠 **上下文截断**：防止长对话超出模型限制

---

## 📜 许可证

MIT License
