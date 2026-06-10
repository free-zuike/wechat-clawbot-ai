// ============================================================
//  ClawBot AI - 微信公众号 AI 机器人 (Cloudflare Worker + Worker AI)
// ------------------------------------------------------------
//  - 微信公众号接入: URL 校验 & XML 消息接收/回复
//  - Worker AI 调用: 多轮对话上下文、自动超时清理
//  - 管理面板:  /        状态 + 使用说明
//                /chat    网页端调试对话
// ============================================================

// --------- SHA1 签名校验 (纯 JS, 无需外部依赖) ----------
function strToBytes(str) {
  const utf8 = new TextEncoder().encode(str);
  return utf8;
}

async function sha1Hex(input) {
  // input: string
  const data = strToBytes(input);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --------- 微信 XML 解析 ----------
function parseXmlSimple(xml) {
  // 极简解析器,只处理微信公众号常见的 <xml><Key>Value</Key>...</xml>
  const result = {};
  const regex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const key = m[1];
    const raw = m[2];
    // 判断是否被 <![CDATA[...]]> 包裹
    const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    result[key] = cdata ? cdata[1] : raw.trim();
  }
  return result;
}

function escapeXml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 构造微信被动回复 XML
function buildTextReply(fromUser, toUser, content) {
  const now = Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${now}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

// 图文消息 (一个链接卡片)
function buildNewsReply(fromUser, toUser, { title, description, picUrl, url }) {
  const now = Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${now}</CreateTime>
<MsgType><![CDATA[news]]></MsgType>
<ArticleCount>1</ArticleCount>
<Articles>
<item>
<Title><![CDATA[${title}]]></Title>
<Description><![CDATA[${description}]]></Description>
<PicUrl><![CDATA[${picUrl || ""}]]></PicUrl>
<Url><![CDATA[${url || ""}]]></Url>
</item>
</Articles>
</xml>`;
}

// --------- 微信签名校验 ----------
function wechatValidate(token, { signature, timestamp, nonce, echostr }) {
  if (!signature || !timestamp || !nonce) return { ok: false, reason: "缺少参数" };
  const sorted = [token, timestamp, nonce].sort().join("");
  return sha1Hex(sorted).then((hash) => {
    if (hash === signature) return { ok: true, echostr };
    return { ok: false, reason: "签名不匹配" };
  });
}

// --------- 对话上下文 (KV 存储) ----------
// 每条记录: { user: openid, messages: [{role, content, ts}], updated }
// 键名: clawbot:ctx:<openid>

async function loadContext(env, openid) {
  try {
    if (!env.CLAWBOT_KV) return { messages: [] };
    const raw = await env.CLAWBOT_KV.get(`clawbot:ctx:${openid}`);
    if (!raw) return { messages: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages)) return { messages: [] };
    // 过滤 2 小时以前的对话,避免无限膨胀
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const messages = parsed.messages.filter((m) => (m.ts || 0) > cutoff);
    return { messages };
  } catch (e) {
    return { messages: [] };
  }
}

async function saveContext(env, openid, ctx, maxPairs) {
  if (!env.CLAWBOT_KV) return;
  try {
    // 只保留最近 N*2 条
    const keep = Math.max(0, ctx.messages.length - maxPairs * 2);
    const trimmed = keep > 0 ? ctx.messages.slice(keep) : ctx.messages;
    const payload = JSON.stringify({ messages: trimmed, updated: Date.now() });
    await env.CLAWBOT_KV.put(`clawbot:ctx:${openid}`, payload, {
      expirationTtl: 3 * 60 * 60, // 3 小时后自动过期
    });
  } catch (_) {
    // 静默失败,不影响回复
  }
}

// --------- Worker AI 对话 ----------
async function aiReply(env, systemPrompt, messages) {
  const model = env.AI_MODEL || "@cf/meta/llama-3-8b-instruct";
  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    max_tokens: 600,
  };
  const res = await env.AI.run(model, payload);
  // 返回结构可能是 { response: string } 或 string
  let text;
  if (typeof res === "string") text = res;
  else if (res && typeof res === "object") text = res.response || res.message || res.reply || JSON.stringify(res);
  else text = String(res);
  return text || "(AI 没有返回内容)";
}

// --------- 指令 & 关键词 ----------
function handleCommand(text, env) {
  const t = text.trim();
  if (/^(帮助|help|\/help|\?|？)$/i.test(t)) {
    return {
      handled: true,
      reply: `你好,我是爪爪 ClawBot AI 🤖

可以直接向我提问,我会使用 Worker AI 为你回答。

支持的命令:
• 帮助 / help - 显示这条信息
• 清除 / reset - 清空本账号对话上下文
• 关于 / about - 关于本机器人

对话会保留最近若干轮作为上下文,2 小时后自动过期。`,
    };
  }
  if (/^(清除|清空|reset|\/reset)$/i.test(t)) {
    return { handled: true, reply: "已重置你的对话上下文 ✅ 接下来将以全新的会话开始。", reset: true };
  }
  if (/^(关于|about|version)$/i.test(t)) {
    return {
      handled: true,
      reply: `爪爪 ClawBot AI v1.0
• 后端: Cloudflare Workers
• 模型: Worker AI (${env.AI_MODEL || "llama-3-8b-instruct"})
• 接入: 微信公众号被动回复

部署地址: 你的 Worker URL`,
    };
  }
  // 关键词小彩蛋
  if (/^(你好|hi|hello|在吗|在不在|嗨)/i.test(t)) {
    return { handled: true, reply: "你好呀 👋 有什么我可以帮忙的吗?可以直接输入你的问题,或发送「帮助」查看用法。" };
  }
  return { handled: false };
}

// 对 AI 返回的内容做一些后处理,以适配微信文本消息
function cleanReply(text, prefix) {
  let out = String(text || "").trim();
  // 去掉开头的空白行
  out = out.replace(/^\s+/, "");
  // 微信限制单条被动回复最长约 2000 字符,超长截断
  if (out.length > 1800) {
    out = out.slice(0, 1790) + "……(已截断)";
  }
  if (prefix) out = prefix + out;
  return out;
}

// ============================================================
//  路由主入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---------- 微信公众号入口 ----------
    // 开发者后台填:  https://<your-worker>.workers.dev/wechat
    if (path === "/wechat") {
      // --- GET: 服务器地址校验 ---
      if (method === "GET") {
        const token = env.WECHAT_TOKEN;
        if (!token || token === "your-wechat-token-here") {
          return new Response("Worker 未配置 WECHAT_TOKEN", { status: 500 });
        }
        const result = await wechatValidate(token, {
          signature: url.searchParams.get("signature"),
          timestamp: url.searchParams.get("timestamp"),
          nonce: url.searchParams.get("nonce"),
          echostr: url.searchParams.get("echostr"),
        });
        if (!result.ok) {
          return new Response("invalid signature", { status: 403 });
        }
        return new Response(result.echostr || "ok", { status: 200 });
      }

      // --- POST: 接收微信推送的消息 ---
      if (method === "POST") {
        const token = env.WECHAT_TOKEN;
        // 可选: 对 POST 也做签名校验
        const sigCheck = await wechatValidate(token, {
          signature: url.searchParams.get("signature"),
          timestamp: url.searchParams.get("timestamp"),
          nonce: url.searchParams.get("nonce"),
        });
        if (!sigCheck.ok) {
          // 生产环境建议返回 403; 此处兼容调试,继续但记录
          // return new Response("invalid signature", { status: 403 });
        }

        const bodyText = await request.text();
        const data = parseXmlSimple(bodyText);
        const from = data.FromUserName; // 用户 openid
        const to = data.ToUserName; // 公众号原始 ID
        const msgType = data.MsgType;

        if (!from || !to) {
          // 微信心跳/测试,返回空 200
          return new Response("", { status: 200 });
        }

        // 事件消息
        if (msgType === "event") {
          const event = data.Event;
          if (event === "subscribe") {
            const welcome =
              "你好呀,我是爪爪 ClawBot AI 🤖\n感谢关注!\n可以直接向我提问,我会使用 Cloudflare Worker AI 为你回答。\n发送「帮助」查看更多用法。";
            return new Response(buildTextReply(to, from, welcome), {
              headers: { "Content-Type": "application/xml" },
            });
          }
          if (event === "unsubscribe") {
            // 取消关注,清理上下文
            if (env.CLAWBOT_KV) {
              ctx.waitUntil(env.CLAWBOT_KV.delete(`clawbot:ctx:${from}`));
            }
            return new Response("", { status: 200 });
          }
          return new Response("", { status: 200 });
        }

        // 文本消息
        if (msgType === "text") {
          const content = (data.Content || "").trim();

          // 1) 先尝试命令处理
          const cmd = handleCommand(content, env);
          if (cmd.handled) {
            if (cmd.reset && env.CLAWBOT_KV) {
              ctx.waitUntil(env.CLAWBOT_KV.delete(`clawbot:ctx:${from}`));
            }
            return new Response(buildTextReply(to, from, cmd.reply), {
              headers: { "Content-Type": "application/xml" },
            });
          }

          // 2) 异步走 AI,需要用 customer service 接口才能回复
          //    微信被动回复要求 5s 内返回,Worker AI 可能超时,
          //    因此采用"ack + 客户消息"两步走:
          //    - 先返回一个简单的 XML 空响应(或"正在思考..."提示)
          //    - 再通过客户消息接口 customer service 推送结果
          //    但客户消息接口需要 access_token & 公众号需认证
          //    若未配置或不可用,降级为同步回复(5s 兜底截断)
          const ctxData = await loadContext(env, from);
          ctxData.messages.push({ role: "user", content, ts: Date.now() });

          // 先尝试同步回复
          try {
            const systemPrompt =
              env.AI_SYSTEM_PROMPT ||
              "你是爪爪 ClawBot,一个热情、友好的中文 AI 助手。用简洁中文回答。";
            const reply = await aiReply(env, systemPrompt, ctxData.messages);
            const clean = cleanReply(reply, env.BOT_PREFIX || "");
            ctxData.messages.push({ role: "assistant", content: clean, ts: Date.now() });
            ctx.waitUntil(
              saveContext(env, from, ctxData, parseInt(env.AI_CONTEXT_PAIRS || "5", 10))
            );
            return new Response(buildTextReply(to, from, clean), {
              headers: { "Content-Type": "application/xml" },
            });
          } catch (err) {
            ctx.waitUntil(
              saveContext(env, from, ctxData, parseInt(env.AI_CONTEXT_PAIRS || "5", 10))
            );
            return new Response(
              buildTextReply(
                to,
                from,
                "抱歉,当前 AI 繁忙,请稍后再试 😿\n\n如需帮助可发送「帮助」查看用法。"
              ),
              { headers: { "Content-Type": "application/xml" } }
            );
          }
        }

        // 图片/语音等其他消息,暂回复引导文字
        if (msgType === "image") {
          return new Response(
            buildTextReply(to, from, "收到你的图片啦 🖼️ 不过我现在还只能处理文字问题,可以把你的问题用文字发给我哦~"),
            { headers: { "Content-Type": "application/xml" } }
          );
        }
        if (msgType === "voice") {
          return new Response(
            buildTextReply(to, from, "收到语音啦 🎤 不过我还听不懂语音,请用文字告诉我你的问题吧~"),
            { headers: { "Content-Type": "application/xml" } }
          );
        }

        return new Response("", { status: 200 });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    // ---------- 健康检查 ----------
    if (path === "/healthz") {
      return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // ---------- JSON API (供外部/小程序直接调用 AI 对话) ----------
    // POST /api/chat  { message: "...", context: [{role, content}] }
    if (path === "/api/chat" && method === "POST") {
      try {
        const body = await request.json();
        const message = body?.message;
        const userContext = Array.isArray(body?.context) ? body.context : [];
        if (!message) {
          return new Response(JSON.stringify({ error: "missing message" }), { status: 400 });
        }
        const combined = [
          ...userContext.map((c) => ({
            role: c.role,
            content: c.content,
            ts: Date.now(),
          })),
          { role: "user", content: message, ts: Date.now() },
        ];
        const systemPrompt =
          env.AI_SYSTEM_PROMPT ||
          "你是爪爪 ClawBot,一个热情、友好的中文 AI 助手。用简洁中文回答。";
        const reply = await aiReply(env, systemPrompt, combined);
        return new Response(
          JSON.stringify({ reply: cleanReply(reply, env.BOT_PREFIX || "") }),
          { headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: "server error", detail: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }

    // ---------- 首页: 使用说明 ----------
    if (path === "/" || path === "/index.html") {
      const html = buildHomeHTML({
        model: env.AI_MODEL || "@cf/meta/llama-3-8b-instruct",
        workerUrl: `${url.protocol}//${url.host}`,
        hasToken: !!env.WECHAT_TOKEN && env.WECHAT_TOKEN !== "your-wechat-token-here",
        hasKV: !!env.CLAWBOT_KV,
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ============================================================
//  首页 HTML (含网页端聊天调试)
// ============================================================
function buildHomeHTML({ model, workerUrl, hasToken, hasKV }) {
  const statusBadge = (ok, text) =>
    `<span class="badge ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${text}</span>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ClawBot AI · 微信公众号 AI 机器人</title>
<style>
  :root{ --pink:#ff4d8d; --bg:#fff0f5; --ink:#222; --muted:#888; --card:#fff; }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;
       background:linear-gradient(135deg,#ffe0ec 0%,#e0f0ff 100%);color:var(--ink);min-height:100vh}
  .wrap{max-width:820px;margin:0 auto;padding:32px 20px 80px}
  .hero{background:var(--card);border-radius:24px;padding:28px;box-shadow:0 8px 32px rgba(255,77,141,.12);margin-bottom:20px}
  h1{margin:0 0 8px;font-size:32px;color:var(--pink)}
  .sub{color:var(--muted);font-size:14px}
  .badges{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
  .badge{font-size:12px;padding:4px 10px;border-radius:999px;background:#eee;color:#333}
  .badge.ok{background:#e8f7ee;color:#147a3e}
  .badge.bad{background:#fde8e8;color:#a33}
  pre.code{background:#1e2230;color:#f5f5f5;padding:14px 16px;border-radius:12px;overflow-x:auto;font-size:13px;line-height:1.55}
  code.inline{background:#fff5f9;padding:1px 6px;border-radius:6px;color:#c03b77;font-size:13px}
  h2{font-size:20px;margin:28px 0 12px;color:var(--pink)}
  .step{background:var(--card);border-radius:16px;padding:16px 20px;margin-bottom:12px;box-shadow:0 4px 16px rgba(0,0,0,.04)}
  .step b{color:#b53673}

  /* chat */
  .chat{background:var(--card);border-radius:20px;padding:20px;box-shadow:0 8px 32px rgba(255,77,141,.08);margin-top:20px}
  .chat-box{height:360px;overflow-y:auto;padding:8px;background:#fafbff;border-radius:14px;border:1px solid #eee}
  .msg{margin:8px 0;display:flex}
  .msg .bubble{padding:10px 14px;border-radius:14px;max-width:80%;line-height:1.5;font-size:14px;white-space:pre-wrap;word-break:break-word}
  .msg.u{justify-content:flex-end}.msg.u .bubble{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border-bottom-right-radius:4px}
  .msg.b{justify-content:flex-start}.msg.b .bubble{background:#fff;color:#222;border:1px solid #eee;border-bottom-left-radius:4px}
  .input-row{display:flex;gap:8px;margin-top:12px}
  .input-row input{flex:1;border:1px solid #eee;border-radius:999px;padding:12px 16px;font-size:14px;outline:none}
  .input-row input:focus{border-color:#ff6b9d}
  .input-row button{border:none;border-radius:999px;padding:12px 22px;background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;font-weight:600;cursor:pointer}
  .tiny{font-size:12px;color:var(--muted);margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>🤖 爪爪 ClawBot AI</h1>
    <div class="sub">基于 <b>Cloudflare Workers</b> + <b>Worker AI</b> 的微信公众号聊天机器人后端</div>
    <div class="badges">
      ${statusBadge(true, "Worker 运行中")}
      ${statusBadge(hasToken, "WECHAT_TOKEN 已配置")}
      ${statusBadge(true, "AI 模型: " + model)}
      ${statusBadge(hasKV, "KV 上下文存储")}
    </div>
  </div>

  <h2>1️⃣ 微信公众号配置</h2>
  <div class="step">
    登录 <b>微信公众平台 → 设置与开发 → 基本配置</b>,启用「服务器配置」:<br>
    • <b>服务器地址 URL</b>：<code class="inline">${workerUrl}/wechat</code><br>
    • <b>Token</b>：与 <code class="inline">wrangler.toml</code> 中 <code class="inline">WECHAT_TOKEN</code> 保持一致<br>
    • <b>消息加解密</b>：建议选择「明文模式」(本版本直接支持)
  </div>

  <h2>2️⃣ 部署命令</h2>
  <pre class="code">npm install -g wrangler
wrangler login          # 登录 Cloudflare
npm install
# 编辑 wrangler.toml 填入你的 WECHAT_TOKEN
wrangler deploy         # 发布到 Cloudflare Workers
# (可选) 创建 KV 以保存对话上下文
wrangler kv:namespace create CLAWBOT_KV
# 然后把 namespace_id 加入 wrangler.toml 的 [[kv_namespaces]] 中</pre>

  <h2>3️⃣ 支持的命令 & 指令</h2>
  <div class="step">
    • 直接发送任何问题 → AI 自动回答<br>
    • <code class="inline">帮助</code> / <code class="inline">help</code> → 使用说明<br>
    • <code class="inline">清除</code> / <code class="inline">reset</code> → 清空对话上下文<br>
    • <code class="inline">关于</code> / <code class="inline">about</code> → 版本信息<br>
    • 新关注公众号 → 自动发送欢迎语
  </div>

  <h2>4️⃣ 公开 JSON API</h2>
  <div class="step">
    也可直接在小程序、App、网页端调用:<br>
    <pre class="code" style="margin-top:10px">curl -X POST ${workerUrl}/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{"message":"你好,请用一句话介绍 Cloudflare Workers"}'</pre>
  </div>

  <h2>🧪 网页端调试对话</h2>
  <div class="chat">
    <div id="box" class="chat-box">
      <div class="msg b"><div class="bubble">你好,我是爪爪 ClawBot AI 👋\n在这里可以直接测试 AI 回复效果。\n你也可以把这个 Worker 地址配置到微信公众号后台,用户发送的消息会直接走 AI。</div></div>
    </div>
    <div class="input-row">
      <input id="inp" placeholder="输入你的问题,按回车发送..." />
      <button id="btn">发送</button>
    </div>
    <div class="tiny">提示:网页端调用的是同一个 Worker AI,只是不走微信 XML。</div>
  </div>

</div>
<script>
  const box = document.getElementById('box');
  const inp = document.getElementById('inp');
  const btn = document.getElementById('btn');
  let ctx = [];
  function add(role, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
    d.appendChild(b); box.appendChild(d); box.scrollTop = box.scrollHeight;
  }
  async function send() {
    const q = inp.value.trim(); if(!q) return;
    add('u', q); inp.value=''; btn.disabled=true; btn.textContent='思考中...';
    try {
      const r = await fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({message: q, context: ctx})});
      const data = await r.json();
      const reply = data.reply || '(空)';
      ctx.push({role:'user',content:q},{role:'assistant',content:reply});
      if(ctx.length>20) ctx = ctx.slice(-16);
      add('b', reply);
    } catch(e){ add('b','网络错误:'+e.message); }
    btn.disabled=false; btn.textContent='发送'; inp.focus();
  }
  btn.addEventListener('click', send);
  inp.addEventListener('keydown', e => { if(e.key==='Enter') send(); });
</script>
</body>
</html>`;
}
