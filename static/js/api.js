// Клиент HTTP API. Анонимная сессия (id + токен) хранится в localStorage.

const SESSION_KEY = "thewall.session";

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let session = readSession();
let registering = null;

function readSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return saved && saved.id && saved.token ? saved : null;
  } catch {
    return null;
  }
}

function writeSession(value) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  } catch {
    // Приватный режим или запрет хранилища: сессия проживёт до перезагрузки.
  }
}

async function send(method, path, body, { auth = true, headers = {} } = {}) {
  const allHeaders = { Accept: "application/json", ...headers };
  if (body !== undefined) allHeaders["Content-Type"] = "application/json";
  if (auth && session) allHeaders.Authorization = `Bearer ${session.token}`;
  try {
    return await fetch(path, {
      method,
      headers: allHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Нет связи с сервером. Проверьте интернет и попробуйте ещё раз", 0);
  }
}

async function parse(response) {
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Тело не JSON (например, страница ошибки прокси).
  }
  if (!response.ok) {
    const fallback = response.status >= 500
      ? "Сервер временно недоступен, попробуйте позже"
      : `Ошибка ${response.status}`;
    throw new ApiError((data && data.error) || fallback, (data && data.code) || response.status);
  }
  return data;
}

async function register() {
  const data = await parse(await send("POST", "/users", undefined, { auth: false }));
  session = { id: data.id, token: data.token };
  writeSession(session);
  return session;
}

export function ensureSession() {
  if (session) return Promise.resolve(session);
  if (!registering) registering = register().finally(() => { registering = null; });
  return registering;
}

async function authed(method, path, body) {
  await ensureSession();
  let response = await send(method, path, body);
  if (response.status === 401) {
    // Токен больше не принимается (например, сменили SECRET_KEY) — получаем новый.
    session = null;
    await ensureSession();
    response = await send(method, path, body);
  }
  return parse(response);
}

export const api = {
  async config() {
    return parse(await send("GET", "/config", undefined, { auth: false }));
  },

  // Возвращает { notModified: true }, если стена не изменилась с прошлого запроса.
  async wall(etag) {
    const response = await send("GET", "/posts", undefined, { headers: etag ? { "If-None-Match": etag } : {} });
    if (response.status === 304) return { notModified: true, etag };
    const data = await parse(response);
    return { notModified: false, etag: response.headers.get("ETag"), data };
  },

  createPost: (text, x, y) => authed("POST", "/posts", { text, x, y }),
  movePost: (id, x, y) => authed("PATCH", `/posts/${id}`, { x, y }),
  deletePost: (id) => authed("DELETE", `/posts/${id}`),
  createLine: (points, color, thickness) => authed("POST", "/lines", { points, color, thickness }),
  deleteLine: (id) => authed("DELETE", `/lines/${id}`),
  createZone: (rect) => authed("POST", "/zones", rect),
  deleteZone: (id) => authed("DELETE", `/zones/${id}`),
};
