// API 封装
const API_BASE = "";

function withPwd(path: string, pwd: string): string {
  if (!pwd) return API_BASE + path;
  const sep = path.includes("?") ? "&" : "?";
  return API_BASE + path + sep + "pwd=" + encodeURIComponent(pwd);
}

export async function fetchStatus(pwd: string) {
  const res = await fetch(withPwd("/api/status", pwd));
  return res.json();
}

export async function fetchConfig(pwd: string) {
  const res = await fetch(withPwd("/api/config", pwd));
  return res.json();
}

export async function saveConfig(pwd: string, config: any) {
  const res = await fetch(withPwd("/api/config", pwd), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function triggerPoll(pwd: string) {
  const res = await fetch(withPwd("/api/trigger-poll", pwd), {
    method: "POST",
  });
  return res.json();
}

export async function logout(pwd: string) {
  const res = await fetch(withPwd("/api/logout", pwd), {
    method: "POST",
  });
  return res.json();
}

export async function getQRCode(pwd: string) {
  const res = await fetch(withPwd("/api/qrcode", pwd));
  return res.json();
}

export async function getQRCodeStatus(pwd: string) {
  const res = await fetch(withPwd("/api/qrcode-status", pwd));
  return res.json();
}

export async function checkLogin() {
  const res = await fetch("/api/check-login");
  return res.json();
}

export async function chat(message: string) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return res.json();
}
