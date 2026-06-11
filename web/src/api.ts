const API_BASE = "";

export async function fetchJSON(path: string, options: RequestInit = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res.json();
}

export async function getStatus(pwd: string) {
  return fetchJSON(`/api/status?pwd=${encodeURIComponent(pwd)}`);
}

export async function triggerPoll(pwd: string) {
  return fetchJSON(`/api/trigger-poll?pwd=${encodeURIComponent(pwd)}`, {
    method: "POST",
  });
}

export async function logout(pwd: string) {
  return fetchJSON(`/api/logout?pwd=${encodeURIComponent(pwd)}`, {
    method: "POST",
  });
}

export async function chat(message: string) {
  return fetchJSON("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function loadConfig(pwd: string) {
  return fetchJSON(`/api/config?pwd=${encodeURIComponent(pwd)}`);
}

export async function saveConfig(pwd: string, config: any) {
  return fetchJSON(`/api/config?pwd=${encodeURIComponent(pwd)}`, {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export async function getQRCode(pwd: string) {
  return fetchJSON(`/api/qrcode?pwd=${encodeURIComponent(pwd)}`);
}

export async function getQRCodeStatus(pwd: string) {
  return fetchJSON(`/api/qrcode-status?pwd=${encodeURIComponent(pwd)}`);
}

export async function getHistory(pwd: string) {
  return fetchJSON(`/api/history?pwd=${encodeURIComponent(pwd)}&hours=24`);
}

export async function getR2History(pwd: string, user = "") {
  return fetchJSON(
    `/api/r2-history?pwd=${encodeURIComponent(pwd)}&user=${encodeURIComponent(user)}&limit=30`
  );
}
