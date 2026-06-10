// Cloudflare Worker + Worker AI - 夹娃娃AI机器人后端
// 功能: 夹娃娃游戏逻辑 + AI对话 + AI生成奖励图像

const CLAW_GIFTS = [
  { id: 1, name: "小熊玩偶", emoji: "🧸", rarity: "rare", points: 100 },
  { id: 2, name: "小兔子", emoji: "🐰", rarity: "common", points: 10 },
  { id: 3, name: "小猫咪", emoji: "🐱", rarity: "common", points: 15 },
  { id: 4, name: "独角兽", emoji: "🦄", rarity: "rare", points: 80 },
  { id: 5, name: "小鸭子", emoji: "🦆", rarity: "common", points: 8 },
  { id: 6, name: "超级大奖", emoji: "🏆", rarity: "legendary", points: 500 },
  { id: 7, name: "小狗狗", emoji: "🐶", rarity: "common", points: 12 },
  { id: 8, name: "小狐狸", emoji: "🦊", rarity: "uncommon", points: 30 },
  { id: 9, name: "小熊猫", emoji: "🐼", rarity: "rare", points: 100 },
  { id: 10, name: "彩虹糖", emoji: "🍬", rarity: "common", points: 5 }
];

async function pickGift() {
  const rand = Math.random();
  if (rand < 0.01) return CLAW_GIFTS.find(g => g.rarity === "legendary");
  if (rand < 0.15) {
    const rares = CLAW_GIFTS.filter(g => g.rarity === "rare");
    return rares[Math.floor(Math.random() * rares.length)];
  }
  if (rand < 0.35) {
    const uncommons = CLAW_GIFTS.filter(g => g.rarity === "uncommon");
    return uncommons[Math.floor(Math.random() * uncommons.length)];
  }
  const commons = CLAW_GIFTS.filter(g => g.rarity === "common");
  return commons[Math.floor(Math.random() * commons.length)];
}

async function aiChat(env, message, history = []) {
  const messages = [
    { role: "system", content: "你是一个夹娃娃机的AI助手爪爪。你是一个温柔可爱的卡通角色,说话风格可爱、鼓励人,喜欢鼓励大家来夹娃娃。每次回答简短有趣,用中文回复。" },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: message }
  ];

  try {
    const response = await env.AI.run(env.AI_MODEL, {
      messages,
      max_tokens: 200
    });
    return response.response || response;
  } catch (e) {
    return "呜呜,AI暂时休息了,但爪爪会一直陪着你～";
  }
}

async function generateGiftImage(env, giftName) {
  try {
    const prompt = `cute cartoon style, a plush toy of ${giftName}, pastel colors, kawaii style, soft lighting, white background, high quality`;
    const image = await env.AI.run(env.IMAGE_MODEL, { prompt });
    if (image && typeof image === 'object') {
      const base64 = btoa(
        new Uint8Array(image).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      return `data:image/png;base64,${base64}`;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function generateGiftStory(env, giftName, userName) {
  try {
    const messages = [
      { role: "system", content: "你是一个可爱的讲故事助手,用中文为夹娃娃游戏写一段简短有趣的获奖故事。" },
      { role: "user", content: `用户${userName}刚刚抓到了一只${giftName},请写一段30字以内的有趣祝贺故事。` }
    ];
    const response = await env.AI.run(env.AI_MODEL, { messages, max_tokens: 80 });
    return response.response || response;
  } catch (e) {
    return `恭喜${userName}抓到了${giftName},好厉害呀!`;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headers = { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" };

    if (request.method === "OPTIONS") {
      return new Response("OK", { headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({
        message: "欢迎来到夹娃娃AI机器人!",
        endpoints: {
          health: "/health",
          play: "/api/play",
          chat: "/api/chat",
          gifts: "/api/gifts",
          wechatLogin: "/api/wechat/login"
        }
      }), { headers });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", time: Date.now() }), { headers });
    }

    if (request.method === "GET" && url.pathname === "/api/gifts") {
      return new Response(JSON.stringify({ gifts: CLAW_GIFTS }), { headers });
    }

    if (request.method === "POST" && url.pathname === "/api/play") {
      const body = await request.json().catch(() => ({}));
      const { userName = "玩家", attempts = 1 } = body;
      const gift = await pickGift();
      const success = Math.random() > 0.3;
      const story = success ? await generateGiftStory(env, gift.name, userName) : null;

      return new Response(JSON.stringify({
        success,
        gift: success ? gift : null,
        message: success ? `恭喜${userName}抓到了${gift.emoji}${gift.name}!` : "哎呀,差一点就抓到了,再来一次吧!",
        story,
        attempts
      }), { headers });
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await request.json().catch(() => ({}));
      const { message = "", history = [] } = body;
      if (!message) {
        return new Response(JSON.stringify({ error: "请输入消息" }), { headers });
      }
      const reply = await aiChat(env, message, history);
      return new Response(JSON.stringify({ reply }), { headers });
    }

    if (request.method === "POST" && url.pathname === "/api/wechat/login") {
      const body = await request.json().catch(() => ({}));
      const { code } = body;
      if (!code) {
        return new Response(JSON.stringify({ error: "缺少code" }), { headers });
      }
      try {
        const apiUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${env.WECHAT_APP_ID}&secret=${env.WECHAT_APP_SECRET}&js_code=${code}&grant_type=authorization_code`;
        const resp = await fetch(apiUrl);
        const data = await resp.json();
        return new Response(JSON.stringify(data), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: "登录失败" }), { headers });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/gift/image") {
      const body = await request.json().catch(() => ({}));
      const { giftName } = body;
      if (!giftName) {
        return new Response(JSON.stringify({ error: "缺少礼物名称" }), { headers });
      }
      const image = await generateGiftImage(env, giftName);
      return new Response(JSON.stringify({ image }), { headers });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers });
  }
};
