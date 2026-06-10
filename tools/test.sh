#!/usr/bin/env bash
# ============================================================
#  test.sh - 本地测试微信接入 & AI 对话
#  依赖: curl, python3 (仅用于 sha1 签名)
#  用法:
#    1) 先启动 worker:   wrangler dev
#    2) 另开终端执行:     bash tools/test.sh "你的问题"
# ============================================================
set -euo pipefail

WORKER_URL="${WORKER_URL:-http://localhost:8787}"
TOKEN="${WECHAT_TOKEN:-your-wechat-token-here}"
MESSAGE="${1:-你好,介绍一下你自己}"

sign() {
    # $1: token; $2: timestamp; $3: nonce
    python3 -c "import hashlib;print(hashlib.sha1(''.join(sorted(['$1','$2','$3'])).encode()).hexdigest())"
}

echo "======================"
echo " 1️⃣  GET /wechat (签名校验)"
echo "======================"
TS=$(date +%s)
NONCE=$(python3 -c "import uuid;print(uuid.uuid4().hex[:10])")
ECHOSTR=$(python3 -c "import uuid;print(uuid.uuid4().hex)")
SIG=$(sign "$TOKEN" "$TS" "$NONCE")

RESP=$(curl -sS "$WORKER_URL/wechat?signature=$SIG&timestamp=$TS&nonce=$NONCE&echostr=$ECHOSTR")
echo "  请求 signature = $SIG"
echo "  期望 echostr  = $ECHOSTR"
echo "  返回内容      = $RESP"
if [ "$RESP" = "$ECHOSTR" ]; then
    echo "  ✓ 签名校验通过"
else
    echo "  ✗ 签名校验失败 (请确认 TOKEN 与 worker 配置一致)"
fi

echo ""
echo "======================"
echo " 2️⃣  POST /wechat (文本消息 -> AI 回复 XML)"
echo "======================"
TS2=$(date +%s)
NONCE2=$(python3 -c "import uuid;print(uuid.uuid4().hex[:10])")
SIG2=$(sign "$TOKEN" "$TS2" "$NONCE2")
MSG_ID=$(python3 -c "import uuid;print(uuid.uuid4().int & (1<<48)-1)")
OPENID="oTestUser$(python3 -c "import uuid;print(uuid.uuid4().hex[:8])")"

XML_BODY=$(cat <<EOF
<xml>
<ToUserName><![CDATA[gh_your_official_account]]></ToUserName>
<FromUserName><![CDATA[$OPENID]]></FromUserName>
<CreateTime>$TS2</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[$MESSAGE]]></Content>
<MsgId>$MSG_ID</MsgId>
</xml>
EOF
)

echo "  发送消息: $MESSAGE"
echo ""
curl -sS -X POST \
     "$WORKER_URL/wechat?signature=$SIG2&timestamp=$TS2&nonce=$NONCE2" \
     -H "Content-Type: application/xml" \
     -d "$XML_BODY" \
     | tee /tmp/clawbot_resp.xml

echo ""
echo ""
echo "======================"
echo " 3️⃣  POST /api/chat (JSON API 直接对话)"
echo "======================"
curl -sS -X POST "$WORKER_URL/api/chat" \
     -H "Content-Type: application/json" \
     -d "{\"message\":\"$MESSAGE\"}" | python3 -m json.tool
