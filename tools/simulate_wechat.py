#!/usr/bin/env python3
"""
simulate_wechat.py - 本地模拟微信公众号签名校验与 XML 消息推送
用法:
    # 启动本地 worker
    wrangler dev
    # 另开终端
    python tools/simulate_wechat.py http://localhost:8787 "你的问题"
"""
import hashlib
import sys
import time
import uuid
import requests
import xml.etree.ElementTree as ET


def sha1_hex(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def build_text_xml(from_user, to_user, content):
    return f"""<xml>
<ToUserName><![CDATA[{to_user}]]></ToUserName>
<FromUserName><![CDATA[{from_user}]]></FromUserName>
<CreateTime>{int(time.time())}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[{content}]]></Content>
<MsgId>{uuid.uuid4().int & 0xFFFFFFFFFFFF}</MsgId>
</xml>"""


def main():
    if len(sys.argv) < 2:
        print("用法: python simulate_wechat.py <worker_url> [消息内容]")
        print("示例: python simulate_wechat.py http://localhost:8787 你好")
        sys.exit(1)

    base = sys.argv[1].rstrip("/")
    message = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else "你好,介绍一下你自己"
    token = "your-wechat-token-here"  # 与 wrangler.toml 中一致

    # ----- 1. 测试 URL 校验 (GET /wechat) -----
    ts = str(int(time.time()))
    nonce = uuid.uuid4().hex[:10]
    echostr = uuid.uuid4().hex
    sig = sha1_hex("".join(sorted([token, ts, nonce])))
    r = requests.get(
        f"{base}/wechat",
        params={"signature": sig, "timestamp": ts, "nonce": nonce, "echostr": echostr},
        timeout=10,
    )
    print(f"[GET /wechat] status={r.status_code} body={r.text!r}")
    assert r.status_code == 200 and r.text == echostr, "签名校验失败"
    print("  ✓ 签名校验通过")

    # ----- 2. 测试文本消息 (POST /wechat) -----
    fake_openid = "oTestUserOpenId" + uuid.uuid4().hex[:6]
    fake_ghid = "gh_your_official_account"
    body = build_text_xml(fake_openid, fake_ghid, message)
    ts2 = str(int(time.time()))
    nonce2 = uuid.uuid4().hex[:10]
    sig2 = sha1_hex("".join(sorted([token, ts2, nonce2])))
    print(f"\n[POST /wechat] 发送: {message!r}")
    r = requests.post(
        f"{base}/wechat",
        params={"signature": sig2, "timestamp": ts2, "nonce": nonce2},
        data=body.encode("utf-8"),
        headers={"Content-Type": "application/xml"},
        timeout=30,
    )
    print(f"  status={r.status_code}")
    print(f"  body=\n{r.text}")

    # 尝试解析回复
    try:
        root = ET.fromstring(r.text)
        content = root.findtext("Content")
        msg_type = root.findtext("MsgType")
        if msg_type:
            print(f"\n  ✓ 解析成功: MsgType={msg_type}, Content={content!r}")
    except Exception as e:
        print(f"  ⚠ 无法解析为 XML: {e}")

    # ----- 3. 测试 JSON API -----
    print(f"\n[POST /api/chat] JSON API 测试")
    rj = requests.post(
        f"{base}/api/chat",
        json={"message": message},
        timeout=30,
    )
    print(f"  status={rj.status_code} reply={rj.json()}")


if __name__ == "__main__":
    main()
