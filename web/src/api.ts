// API 封装
const API_BASE = "";

function withPwd(path: string, pwd: string): string {
  if (!pwd) return API_BASE + path;
  const sep = path.includes("?") ? "&" : "?";
  return API_BASE + path + sep + "pwd=" + encodeURIComponent(pwd);
}

export async function fetchStatus(checkToken = false) {
  const url = checkToken ? API_BASE + "/api/status?checkToken=true" : API_BASE + "/api/status";
  const res = await fetch(url);
  return res.json();
}

export async function fetchConfig() {
  const res = await fetch(API_BASE + "/api/config");
  return res.json();
}

export async function saveConfig(config: any) {
  const res = await fetch(API_BASE + "/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function triggerPoll() {
  const res = await fetch(API_BASE + "/api/trigger-poll", {
    method: "POST",
  });
  return res.json();
}

export async function logout() {
  const res = await fetch(API_BASE + "/api/logout", {
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
