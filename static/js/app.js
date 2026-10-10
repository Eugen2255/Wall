// The Wall — клиент: бесконечная стена на HTML5 Canvas.
// Режимы: «Двигать» (стикеры и обзор), «Рисовать», «Создать зону».

import { api, ensureSession } from "./api.js";
import {
  expandRect, findFreeSpot, normalizeRect, pointInRect, polylineBounds, polylineIntersectsRect,
  rectArea, rectsIntersect, simplifyPolyline,
} from "./geometry.js";

// ---------- Константы отображения ----------

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
const DRAG_THRESHOLD = 4;      // px экрана: меньше — это щелчок, а не перетаскивание
const TEXT_MIN_SCALE = 0.45;   // мельче этого масштаба текст стикеров заменяется штрихами
const STICKER_PAD = 16;
const MIN_FONT = 9;
const MAX_FONT = 28;
const FONT_FAMILY = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const STICKER_COLORS = ["#fff27a", "#ffc9de", "#c6f1c0", "#bfe0ff", "#e1d2ff", "#ffd59e", "#b9f0e4", "#f9d7c4"];
const DRAW_COLORS = ["#000000", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"];
const WALL_COLOR = "#efebe3";
const GRID_COLOR = "rgba(80, 64, 40, 0.18)";
const MINE = { fill: "rgba(22, 163, 74, 0.07)", stroke: "#16a34a", label: "🔒 Ваша зона" };
const FOREIGN = { fill: "rgba(217, 45, 32, 0.06)", stroke: "#d92d20", label: "🔒 Приватная зона" };
const TOP_UI_HEIGHT = 72;      // под верхней панелью подписи зон не рисуем

// ---------- DOM ----------

const $ = (selector) => document.querySelector(selector);
const canvas = $("#wall");
const ctx = canvas.getContext("2d");
const ui = {
  coords: $("#coords"),
  netDot: $("#net-dot"),
  loading: $("#loading"),
  loadingText: $("#loading-text"),
  loadingHint: $("#loading-hint"),
  empty: $("#empty-state"),
  toasts: $("#toasts"),
  drawPanel: $("#draw-panel"),
  zonePanel: $("#zone-panel"),
  zoneFree: $("#zone-free"),
  swatches: $("#swatches"),
  colorInput: $("#color-input"),
  thicknessInput: $("#thickness-input"),
  thicknessValue: $("#thickness-value"),
  postDialog: $("#post-dialog"),
  postForm: $("#post-form"),
  postText: $("#post-text"),
  postCounter: $("#post-counter"),
  postSubmit: $("#post-submit"),
  viewDialog: $("#view-dialog"),
  viewMeta: $("#view-meta"),
  viewText: $("#view-text"),
  viewDelete: $("#view-delete"),
  helpDialog: $("#help-dialog"),
};

// ---------- Состояние ----------

// Значения по умолчанию; при загрузке заменяются ответом GET /config.
const cfg = {
  post_width: 220,
  post_height: 220,
  max_text_length: 500,
  max_line_points: 100,
  default_color: "#000000",
  default_thickness: 2,
  min_thickness: 1,
  max_thickness: 20,
  min_zone_size: 100,
  max_zones_per_user: 10,
  free_zone_area: 1_000_000,
  poll_interval_seconds: 5,
};

const state = {
  loaded: false,
  mode: "move",
  posts: new Map(),
  lines: new Map(),
  zones: new Map(),
  order: [],                 // id постов снизу вверх
  raised: new Map(),         // id → номер «поднятия» после перетаскивания (только локально)
  raiseCounter: 0,
  etag: null,
  pendingMoves: new Map(),   // id → {x, y}: перемещения, ещё не подтверждённые сервером
  pendingLines: [],
  color: cfg.default_color,
  thickness: cfg.default_thickness,
  newPostAt: null,
  hoverPostId: null,
  viewPostId: null,
  flash: null,
};

const camera = { x: 0, y: 0, scale: 1 };  // x, y — мировые координаты левого верхнего угла экрана
const pointers = new Map();
const layoutCache = new Map();
let gesture = null;
let spaceDown = false;
let viewW = 0;
let viewH = 0;
let dpr = 1;
let drawQueued = false;
let pollTimer = null;
let polling = false;
let hashTimer = null;

// ---------- Утилиты ----------

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const round1 = (value) => Math.round(value * 10) / 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const font = (size, weight = 400) => `${weight} ${size}px ${FONT_FAMILY}`;
const timeOf = (item) => Date.parse(item.created_at) || 0;

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function stickerColor(userId) {
  return userId ? STICKER_COLORS[hashString(userId) % STICKER_COLORS.length] : "#ece8df";
}

function tiltOf(id) {
  return ((hashString(id) % 1000) / 1000 - 0.5) * 0.042;  // ±1.2°
}

function formatTime(iso) {
  const date = new Date(iso);
  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return "только что";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
  return date.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

function toast(message, kind = "error") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  ui.toasts.append(el);
  while (ui.toasts.children.length > 3) ui.toasts.firstElementChild.remove();
  setTimeout(() => el.classList.add("hide"), 3200);
  setTimeout(() => el.remove(), 3600);
}

// ---------- Камера ----------

function toWorld(sx, sy) {
  return { x: sx / camera.scale + camera.x, y: sy / camera.scale + camera.y };
}

function toScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.scale, y: (wy - camera.y) * camera.scale };
}

function viewRect(margin = 0) {
  return {
    x1: camera.x - margin,
    y1: camera.y - margin,
    x2: camera.x + viewW / camera.scale + margin,
    y2: camera.y + viewH / camera.scale + margin,
  };
}

function screenCenterWorld() {
  return toWorld(viewW / 2, viewH / 2);
}

function centerOn(wx, wy, scale = camera.scale) {
  camera.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
  camera.x = wx - viewW / 2 / camera.scale;
  camera.y = wy - viewH / 2 / camera.scale;
  cameraChanged();
}

function zoomAt(sx, sy, factor) {
  const anchor = toWorld(sx, sy);
  camera.scale = clamp(camera.scale * factor, MIN_SCALE, MAX_SCALE);
  camera.x = anchor.x - sx / camera.scale;
  camera.y = anchor.y - sy / camera.scale;
  cameraChanged();
}

function cameraChanged() {
  const center = screenCenterWorld();
  ui.coords.textContent = `${Math.round(center.x)}, ${Math.round(center.y)} · ${Math.round(camera.scale * 100)}%`;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 300);
  requestDraw();
}

// Позиция на стене хранится в адресе (#x,y,масштаб), чтобы ей можно было поделиться.
function writeHash() {
  const center = screenCenterWorld();
  const hash = `#${Math.round(center.x)},${Math.round(center.y)},${camera.scale.toFixed(2)}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function readHash() {
  const match = location.hash.match(/^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), scale: match[3] ? Number(match[3]) : 1 };
}

function resize() {
  const center = viewW ? screenCenterWorld() : null;
  dpr = window.devicePixelRatio || 1;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  if (center) centerOn(center.x, center.y);
  else requestDraw();
}

// ---------- Данные ----------

function postRect(post) {
  return { x1: post.x, y1: post.y, x2: post.x + cfg.post_width, y2: post.y + cfg.post_height };
}

function foreignZones() {
  return [...state.zones.values()].filter((zone) => !zone.is_mine);
}

function myZones() {
  return [...state.zones.values()].filter((zone) => zone.is_mine);
}

function inForeignZone(rect) {
  return foreignZones().some((zone) => rectsIntersect(rect, zone));
}

function usedZoneArea() {
  return myZones().reduce((sum, zone) => sum + rectArea(zone), 0);
}

function withBounds(line) {
  line.bounds = polylineBounds(line.points, line.thickness / 2 + 1);
  return line;
}

function applyWall(data) {
  const draggingId = gesture && gesture.type === "post" ? gesture.id : null;
  const posts = new Map();
  for (const post of data.posts) {
    const local = state.posts.get(post.id);
    const pending = state.pendingMoves.get(post.id);
    if (post.id === draggingId && local) {
      post.x = local.x;
      post.y = local.y;
    } else if (pending) {
      post.x = pending.x;
      post.y = pending.y;
    }
    posts.set(post.id, post);
  }
  state.posts = posts;
  state.lines = new Map(data.lines.map((line) => [line.id, withBounds(line)]));
  state.zones = new Map(data.zones.map((zone) => [zone.id, zone]));
  for (const id of layoutCache.keys()) if (!posts.has(id)) layoutCache.delete(id);
  for (const id of state.raised.keys()) if (!posts.has(id)) state.raised.delete(id);
  if (ui.viewDialog.open && !posts.has(state.viewPostId)) ui.viewDialog.close();
  rebuildOrder();
  updateEmptyState();
  updateZoneFree();
  requestDraw();
}

function rebuildOrder() {
  const rank = (post) => state.raised.get(post.id) || 0;
  state.order = [...state.posts.values()]
    .sort((a, b) => rank(a) - rank(b) || timeOf(a) - timeOf(b))
    .map((post) => post.id);
}

function raise(id) {
  state.raised.set(id, ++state.raiseCounter);
  rebuildOrder();
}

function addPost(post) {
  state.posts.set(post.id, post);
  rebuildOrder();
  updateEmptyState();
  requestDraw();
}

function updateEmptyState() {
  ui.empty.hidden = !state.loaded || state.posts.size > 0;
}

function updateZoneFree() {
  const free = Math.max(0, 1 - usedZoneArea() / cfg.free_zone_area);
  ui.zoneFree.textContent = `${Math.round(free * 100)}%`;
}

// ---------- Раскладка текста стикера ----------

function wrapText(text, maxWidth, limit) {
  const lines = [];
  const measure = (s) => ctx.measureText(s).width;
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      if (lines.length >= limit) return lines;
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        if (lines.length >= limit) return lines;
      }
      // Слово длиннее строки — режем по символам.
      let chars = [...word];
      while (chars.length > 1 && measure(chars.join("")) > maxWidth) {
        let cut = 1;
        while (cut < chars.length && measure(chars.slice(0, cut + 1).join("")) <= maxWidth) cut++;
        lines.push(chars.slice(0, cut).join(""));
        if (lines.length >= limit) return lines;
        chars = chars.slice(cut);
      }
      line = chars.join("");
    }
    lines.push(line);
    if (lines.length >= limit) return lines;
  }
  return lines;
}

function computeLayout(text) {
  const maxWidth = cfg.post_width - STICKER_PAD * 2;
  const maxHeight = cfg.post_height - STICKER_PAD * 2;
  const attempt = (size) => {
    ctx.font = font(size);
    const lineHeight = Math.ceil(size * 1.28);
    const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
    const lines = wrapText(text, maxWidth, maxLines + 1);
    return { size, lineHeight, maxLines, lines };
  };
  // Подбираем самый крупный шрифт, при котором текст помещается (бинарный поиск).
  let lo = MIN_FONT;
  let hi = MAX_FONT;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const layout = attempt(mid);
    if (layout.lines.length <= layout.maxLines) {
      best = layout;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;
  // Не влезает даже минимальным шрифтом — обрезаем многоточием, полный текст откроется по щелчку.
  const layout = attempt(MIN_FONT);
  layout.lines.length = layout.maxLines;
  let last = layout.lines[layout.maxLines - 1] || "";
  while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  layout.lines[layout.maxLines - 1] = `${last}…`;
  return layout;
}

function layoutFor(post) {
  let layout = layoutCache.get(post.id);
  if (!layout || layout.text !== post.text) {
    layout = computeLayout(post.text);
    layout.text = post.text;
    layoutCache.set(post.id, layout);
  }
  return layout;
}

// ---------- Отрисовка ----------

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function draw() {
  drawQueued = false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = WALL_COLOR;
  ctx.fillRect(0, 0, viewW, viewH);
  drawGrid();

  const s = camera.scale * dpr;
  ctx.setTransform(s, 0, 0, s, -camera.x * s, -camera.y * s);
  const view = viewRect(40);
  const dragged = gesture && gesture.type === "post" && gesture.moved && !gesture.locked
    ? state.posts.get(gesture.id) : null;

  drawZones(view);
  for (const id of state.order) {
    const post = state.posts.get(id);
    if (post && post !== dragged && rectsIntersect(postRect(post), view)) drawPost(post);
  }
  for (const line of state.lines.values()) {
    if (rectsIntersect(line.bounds, view)) strokeLine(line.points, line.color, line.thickness);
  }
  for (const line of state.pendingLines) strokeLine(line.points, line.color, line.thickness);
  if (gesture && gesture.type === "draw") strokeLine(gesture.points, state.color, state.thickness);
  if (dragged) drawPost(dragged, { lifted: true, blocked: gesture.blocked });
  if (gesture && gesture.type === "zone") drawZoneDraft(gesture);
  drawFlash();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawZoneLabels(view);
  if (gesture && gesture.type === "zone") drawZoneDraftLabel(gesture);
}

function drawGrid() {
  let step = 40;
  while (step * camera.scale < 16) step *= 2;
  const screenStep = step * camera.scale;
  const radius = clamp(1.4 * camera.scale, 1, 1.6);
  const startX = (Math.ceil(camera.x / step) * step - camera.x) * camera.scale;
  const startY = (Math.ceil(camera.y / step) * step - camera.y) * camera.scale;
  ctx.fillStyle = GRID_COLOR;
  for (let sx = startX; sx < viewW; sx += screenStep) {
    for (let sy = startY; sy < viewH; sy += screenStep) {
      ctx.fillRect(sx - radius, sy - radius, radius * 2, radius * 2);
    }
  }
}

function pathRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawZones(view) {
  ctx.lineWidth = 2 / camera.scale;
  ctx.setLineDash([10 / camera.scale, 6 / camera.scale]);
  for (const zone of state.zones.values()) {
    if (!rectsIntersect(zone, view)) continue;
    const style = zone.is_mine ? MINE : FOREIGN;
    ctx.fillStyle = style.fill;
    ctx.fillRect(zone.x1, zone.y1, zone.x2 - zone.x1, zone.y2 - zone.y1);
    ctx.strokeStyle = style.stroke;
    ctx.strokeRect(zone.x1, zone.y1, zone.x2 - zone.x1, zone.y2 - zone.y1);
  }
  ctx.setLineDash([]);
}

function zoneLabelVisible(zone) {
  return (zone.x2 - zone.x1) * camera.scale >= 70;
}

// Подпись и крестик прижимаются к видимой части зоны, если её край ушёл за экран.
function deleteHandle(zone) {
  const topLeft = toScreen(zone.x1, zone.y1);
  const corner = toScreen(zone.x2, zone.y1);
  const x = Math.max(Math.min(corner.x - 16, viewW - 24), topLeft.x + 16);
  return { x, y: Math.max(corner.y + 16, TOP_UI_HEIGHT), r: 12 };
}

function drawZoneLabels(view) {
  ctx.textBaseline = "middle";
  for (const zone of state.zones.values()) {
    if (!rectsIntersect(zone, view) || !zoneLabelVisible(zone)) continue;
    const style = zone.is_mine ? MINE : FOREIGN;
    const topLeft = toScreen(zone.x1, zone.y1);
    const bottomRight = toScreen(zone.x2, zone.y2);
    ctx.font = font(12, 600);
    const width = ctx.measureText(style.label).width + 16;
    const x = clamp(topLeft.x, 8, bottomRight.x - width);
    const y = clamp(topLeft.y - 14, TOP_UI_HEIGHT, bottomRight.y - 14);
    pathRoundRect(x, y - 11, width, 22, 6);
    ctx.fillStyle = style.stroke;
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(style.label, x + 8, y + 1);

    if (state.mode === "zone" && zone.is_mine) {
      const handle = deleteHandle(zone);
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, handle.r, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = FOREIGN.stroke;
      ctx.stroke();
      ctx.fillStyle = FOREIGN.stroke;
      ctx.font = font(13, 700);
      ctx.textAlign = "center";
      ctx.fillText("✕", handle.x, handle.y + 1);
      ctx.textAlign = "left";
    }
  }
}

function drawPost(post, { lifted = false, blocked = false } = {}) {
  const w = cfg.post_width;
  const h = cfg.post_height;
  ctx.save();
  ctx.translate(post.x + w / 2, post.y + h / 2);
  if (!lifted) ctx.rotate(tiltOf(post.id));
  ctx.translate(-w / 2, -h / 2);

  ctx.fillStyle = lifted ? "rgba(40, 30, 10, 0.22)" : "rgba(40, 30, 10, 0.12)";
  ctx.fillRect(lifted ? 8 : 3, lifted ? 12 : 5, w, h);
  ctx.fillStyle = stickerColor(post.user_id);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";  // полоска скотча
  ctx.fillRect(w / 2 - 34, -9, 68, 20);

  if (blocked || post.id === state.hoverPostId) {
    ctx.lineWidth = (blocked ? 4 : 2) / camera.scale;
    ctx.strokeStyle = blocked ? FOREIGN.stroke : "rgba(29, 27, 24, 0.45)";
    ctx.strokeRect(0, 0, w, h);
  }
  if (post.is_mine) {
    ctx.fillStyle = "rgba(29, 27, 24, 0.4)";
    ctx.beginPath();
    ctx.arc(w - 12, h - 12, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (camera.scale >= TEXT_MIN_SCALE) {
    drawPostText(post);
  } else {
    // При сильном отдалении текст не читается — рисуем штрихи, это намного быстрее.
    const rows = clamp(Math.ceil(post.text.length / 40), 1, 6);
    ctx.fillStyle = "rgba(29, 27, 24, 0.2)";
    for (let i = 0; i < rows; i++) {
      const width = (w - STICKER_PAD * 2) * (i === rows - 1 && rows > 1 ? 0.6 : 1);
      ctx.fillRect(STICKER_PAD, STICKER_PAD + 8 + i * 28, width, 14);
    }
  }
  ctx.restore();
}

function drawPostText(post) {
  const layout = layoutFor(post);
  const innerHeight = cfg.post_height - STICKER_PAD * 2;
  const centered = layout.lines.length <= 3;
  ctx.font = font(layout.size);
  ctx.fillStyle = "#1f1d1a";
  ctx.textBaseline = "top";
  ctx.textAlign = centered ? "center" : "left";
  const x = centered ? cfg.post_width / 2 : STICKER_PAD;
  let y = STICKER_PAD + Math.max(0, (innerHeight - layout.lines.length * layout.lineHeight) / 2);
  for (const line of layout.lines) {
    ctx.fillText(line, x, y);
    y += layout.lineHeight;
  }
  ctx.textAlign = "left";
}

function strokeLine(points, color, thickness) {
  if (!points.length) return;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0][0], points[0][1], thickness / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Сглаживаем ломаную квадратичными кривыми через середины отрезков.
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

function zoneDraftRect(g) {
  return normalizeRect(g.x0, g.y0, g.x1, g.y1);
}

function drawZoneDraft(g) {
  const r = zoneDraftRect(g);
  const style = g.check.ok ? MINE : FOREIGN;
  ctx.fillStyle = g.check.ok ? "rgba(22, 163, 74, 0.12)" : "rgba(217, 45, 32, 0.1)";
  ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
  ctx.lineWidth = 2 / camera.scale;
  ctx.setLineDash([6 / camera.scale, 4 / camera.scale]);
  ctx.strokeStyle = style.stroke;
  ctx.strokeRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
  ctx.setLineDash([]);
}

function drawZoneDraftLabel(g) {
  const r = zoneDraftRect(g);
  const corner = toScreen(r.x2, r.y2);
  const text = g.check.ok ? `${Math.round(r.x2 - r.x1)} × ${Math.round(r.y2 - r.y1)}` : g.check.reason;
  ctx.font = font(12, 600);
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width + 16;
  const x = clamp(corner.x + 10, 8, viewW - width - 8);
  const y = clamp(corner.y + 18, TOP_UI_HEIGHT, viewH - 90);
  pathRoundRect(x, y - 11, width, 22, 6);
  ctx.fillStyle = g.check.ok ? MINE.stroke : FOREIGN.stroke;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 8, y + 1);
}

function drawFlash() {
  if (!state.flash) return;
  const post = state.posts.get(state.flash.id);
  const left = state.flash.until - performance.now();
  if (!post || left <= 0) {
    state.flash = null;
    return;
  }
  const alpha = left / 1200;
  const grow = (1 - alpha) * 18;
  ctx.lineWidth = 4 / camera.scale;
  ctx.strokeStyle = `rgba(255, 90, 54, ${alpha})`;
  ctx.strokeRect(post.x - grow, post.y - grow, cfg.post_width + grow * 2, cfg.post_height + grow * 2);
  requestDraw();
}

// ---------- Проверки до отправки на сервер ----------

function checkZone(r) {
  const min = cfg.min_zone_size;
  if (r.x2 - r.x1 < min || r.y2 - r.y1 < min) return { ok: false, reason: `Зона слишком маленькая (минимум ${min}×${min})` };
  if (myZones().length >= cfg.max_zones_per_user) {
    return { ok: false, reason: `Можно создать не больше ${cfg.max_zones_per_user} зон` };
  }
  if (usedZoneArea() + rectArea(r) > cfg.free_zone_area) return { ok: false, reason: "Не хватает бесплатной площади" };
  if (foreignZones().some((zone) => rectsIntersect(r, zone))) {
    return { ok: false, reason: "Зона пересекается с чужой приватной зоной" };
  }
  for (const post of state.posts.values()) {
    if (!post.is_mine && rectsIntersect(postRect(post), r)) return { ok: false, reason: "В этой области есть чужие посты" };
  }
  for (const line of state.lines.values()) {
    if (!line.is_mine && rectsIntersect(line.bounds, r)
        && polylineIntersectsRect(line.points, expandRect(r, line.thickness / 2))) {
      return { ok: false, reason: "В этой области есть чужие рисунки" };
    }
  }
  return { ok: true, reason: "" };
}

// ---------- Попадание курсора ----------

function hitPost(wx, wy) {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const post = state.posts.get(state.order[i]);
    if (post && pointInRect(wx, wy, postRect(post))) return post;
  }
  return null;
}

function hitZoneDelete(sx, sy) {
  if (state.mode !== "zone") return null;
  for (const zone of myZones()) {
    if (!zoneLabelVisible(zone)) continue;
    const handle = deleteHandle(zone);
    if (Math.hypot(sx - handle.x, sy - handle.y) <= handle.r + 3) return zone;
  }
  return null;
}

function updateHover(p) {
  let cursor = "default";
  let hoverId = null;
  if (spaceDown) {
    cursor = "grab";
  } else if (state.mode === "move") {
    const w = toWorld(p.x, p.y);
    const post = hitPost(w.x, w.y);
    if (post) {
      hoverId = post.id;
      cursor = "grab";
    }
  } else if (state.mode === "zone") {
    cursor = hitZoneDelete(p.x, p.y) ? "pointer" : "crosshair";
  } else {
    cursor = "crosshair";
  }
  if (hoverId !== state.hoverPostId) {
    state.hoverPostId = hoverId;
    requestDraw();
  }
  canvas.style.cursor = cursor;
}

// ---------- Жесты ----------

const eventPoint = (e) => ({ x: e.clientX, y: e.clientY });

function startPan(p) {
  gesture = { type: "pan", start: p, camX: camera.x, camY: camera.y };
  canvas.style.cursor = "grabbing";
}

function startPinch() {
  cancelGesture();
  const [a, b] = [...pointers.values()];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  gesture = {
    type: "pinch",
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    scale: camera.scale,
    anchor: toWorld(mid.x, mid.y),
  };
}

function cancelGesture() {
  if (!gesture) return;
  if (gesture.type === "post" && gesture.moved && !gesture.locked) {
    const post = state.posts.get(gesture.id);
    if (post) {
      post.x = gesture.origX;
      post.y = gesture.origY;
    }
  }
  gesture = null;
  requestDraw();
}

function onPointerDown(e) {
  if (!state.loaded) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, eventPoint(e));
  if (pointers.size === 2) {
    startPinch();
    return;
  }
  if (pointers.size > 2 || gesture) return;

  const p = eventPoint(e);
  const w = toWorld(p.x, p.y);
  if (e.button === 1 || e.button === 2 || spaceDown) {
    startPan(p);
    return;
  }
  if (e.button !== 0) return;

  if (state.mode === "move") {
    const post = hitPost(w.x, w.y);
    if (!post) {
      startPan(p);
      return;
    }
    gesture = {
      type: "post",
      id: post.id,
      start: p,
      offX: w.x - post.x,
      offY: w.y - post.y,
      origX: post.x,
      origY: post.y,
      moved: false,
      locked: inForeignZone(postRect(post)),
      blocked: false,
    };
  } else if (state.mode === "draw") {
    gesture = { type: "draw", points: [[w.x, w.y]] };
    requestDraw();
  } else if (state.mode === "zone") {
    const zone = hitZoneDelete(p.x, p.y);
    if (zone) {
      pointers.delete(e.pointerId);
      removeZone(zone);
      return;
    }
    gesture = { type: "zone", x0: w.x, y0: w.y, x1: w.x, y1: w.y, check: { ok: false, reason: "" } };
  }
}

function onPointerMove(e) {
  const p = eventPoint(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  if (!gesture) {
    if (state.loaded && e.pointerType === "mouse") updateHover(p);
    return;
  }

  switch (gesture.type) {
    case "pinch": {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      camera.scale = clamp(gesture.scale * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist), MIN_SCALE, MAX_SCALE);
      camera.x = gesture.anchor.x - mid.x / camera.scale;
      camera.y = gesture.anchor.y - mid.y / camera.scale;
      cameraChanged();
      break;
    }
    case "pan": {
      camera.x = gesture.camX - (p.x - gesture.start.x) / camera.scale;
      camera.y = gesture.camY - (p.y - gesture.start.y) / camera.scale;
      cameraChanged();
      break;
    }
    case "post": {
      if (!gesture.moved && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) < DRAG_THRESHOLD) return;
      if (!gesture.moved) {
        gesture.moved = true;
        if (gesture.locked) {
          toast("Пост в чужой приватной зоне — двигать его может только владелец зоны");
          return;
        }
        raise(gesture.id);
        canvas.style.cursor = "grabbing";
      }
      if (gesture.locked) return;
      const post = state.posts.get(gesture.id);
      if (!post) {
        gesture = null;
        return;
      }
      const w = toWorld(p.x, p.y);
      post.x = w.x - gesture.offX;
      post.y = w.y - gesture.offY;
      gesture.blocked = inForeignZone(postRect(post));
      requestDraw();
      break;
    }
    case "draw": {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const w = toWorld(ev.clientX, ev.clientY);
        const last = gesture.points[gesture.points.length - 1];
        if (Math.hypot(w.x - last[0], w.y - last[1]) * camera.scale >= 1.5) gesture.points.push([w.x, w.y]);
      }
      requestDraw();
      break;
    }
    case "zone": {
      const w = toWorld(p.x, p.y);
      gesture.x1 = w.x;
      gesture.y1 = w.y;
      gesture.check = checkZone(zoneDraftRect(gesture));
      requestDraw();
      break;
    }
    default:
      break;
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === "pinch") {
    if (pointers.size === 0) gesture = null;
    return;
  }
  if (e.type === "pointercancel") {
    cancelGesture();
    return;
  }
  const g = gesture;
  gesture = null;
  if (g.type === "post") finishPostDrag(g);
  else if (g.type === "draw") finishStroke(g.points);
  else if (g.type === "zone") finishZone(g);
  if (e.pointerType === "mouse") updateHover(eventPoint(e));
  requestDraw();
}

function onWheel(e) {
  e.preventDefault();
  if (!state.loaded) return;
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 16;
  else if (e.deltaMode === 2) delta *= viewH;
  zoomAt(e.clientX, e.clientY, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
}

function onDoubleClick(e) {
  if (!state.loaded || state.mode !== "move") return;
  const w = toWorld(e.clientX, e.clientY);
  if (!hitPost(w.x, w.y)) openPostDialog(w);
}

// ---------- Действия ----------

async function finishPostDrag(g) {
  const post = state.posts.get(g.id);
  if (!post) return;
  if (!g.moved) {
    openViewDialog(post);
    return;
  }
  if (g.locked) return;
  if (g.blocked) {
    post.x = g.origX;
    post.y = g.origY;
    toast("Нельзя переместить пост в чужую приватную зону");
    requestDraw();
    return;
  }
  const x = round1(post.x);
  const y = round1(post.y);
  post.x = x;
  post.y = y;
  state.pendingMoves.set(post.id, { x, y });
  const isLatest = () => {
    const pending = state.pendingMoves.get(g.id);
    return pending && pending.x === x && pending.y === y;
  };
  try {
    await api.movePost(g.id, x, y);
  } catch (err) {
    const current = state.posts.get(g.id);
    if (current && isLatest()) {
      current.x = g.origX;
      current.y = g.origY;
    }
    toast(err.message);
  } finally {
    if (isLatest()) state.pendingMoves.delete(g.id);
    requestDraw();
  }
}

async function finishStroke(rawPoints) {
  const thickness = state.thickness;
  const color = state.color;
  const simplified = simplifyPolyline(rawPoints, cfg.max_line_points, 0.75 / camera.scale);
  const points = simplified.map(([x, y]) => [round1(x), round1(y)]);
  if (foreignZones().some((zone) => polylineIntersectsRect(points, expandRect(zone, thickness / 2)))) {
    toast("Нельзя рисовать в чужой приватной зоне");
    return;
  }
  const pending = { points, color, thickness };
  state.pendingLines.push(pending);
  requestDraw();
  try {
    const line = await api.createLine(points, color, thickness);
    state.lines.set(line.id, withBounds(line));
  } catch (err) {
    toast(err.message);
  } finally {
    state.pendingLines = state.pendingLines.filter((item) => item !== pending);
    requestDraw();
  }
}

async function undoLastLine() {
  const mine = [...state.lines.values()].filter((line) => line.is_mine);
  if (!mine.length) {
    toast("Нет ваших линий, которые можно отменить", "info");
    return;
  }
  const last = mine.reduce((a, b) => (timeOf(b) >= timeOf(a) ? b : a));
  state.lines.delete(last.id);
  requestDraw();
  try {
    await api.deleteLine(last.id);
  } catch (err) {
    if (err.code !== 404) {
      state.lines.set(last.id, last);
      requestDraw();
    }
    toast(err.message);
  }
}

async function finishZone(g) {
  const r = zoneDraftRect(g);
  if ((r.x2 - r.x1) * camera.scale < 8 && (r.y2 - r.y1) * camera.scale < 8) return;  // просто щелчок
  const check = checkZone(r);
  if (!check.ok) {
    toast(check.reason);
    return;
  }
  try {
    const zone = await api.createZone({ x1: round1(r.x1), y1: round1(r.y1), x2: round1(r.x2), y2: round1(r.y2) });
    state.zones.set(zone.id, zone);
    updateZoneFree();
  } catch (err) {
    toast(err.message);
  }
  requestDraw();
}

async function removeZone(zone) {
  if (!window.confirm("Удалить эту приватную зону? Посты и рисунки в ней останутся на стене.")) return;
  try {
    await api.deleteZone(zone.id);
    state.zones.delete(zone.id);
    updateZoneFree();
    requestDraw();
  } catch (err) {
    toast(err.message);
  }
}

function revealPost(post) {
  const r = postRect(post);
  const v = viewRect();
  const visible = r.x1 >= v.x1 && r.x2 <= v.x2 && r.y1 >= v.y1 && r.y2 <= v.y2;
  if (!visible) centerOn(post.x + cfg.post_width / 2, post.y + cfg.post_height / 2);
  state.flash = { id: post.id, until: performance.now() + 1200 };
  requestDraw();
}

// ---------- Диалоги ----------

function openPostDialog(at = null) {
  state.newPostAt = at;
  ui.postText.value = "";
  updateCounter();
  ui.postDialog.showModal();
  ui.postText.focus();
}

function updateCounter() {
  const length = [...ui.postText.value].length;
  ui.postCounter.textContent = `${length} / ${cfg.max_text_length}`;
  ui.postCounter.classList.toggle("over", length > cfg.max_text_length);
}

async function submitPost(e) {
  e.preventDefault();
  const text = ui.postText.value.trim();
  if (!text) {
    toast("Напишите текст поста");
    ui.postText.focus();
    return;
  }
  if ([...text].length > cfg.max_text_length) {
    toast("Текст слишком длинный");
    return;
  }
  const w = cfg.post_width;
  const h = cfg.post_height;
  let target = state.newPostAt;
  if (!target) {
    // Центр экрана с небольшим разбросом, чтобы новые посты не ложились ровно друг на друга.
    const center = screenCenterWorld();
    target = { x: center.x + (Math.random() - 0.5) * 60, y: center.y + (Math.random() - 0.5) * 60 };
  }
  let spot = { x: target.x - w / 2, y: target.y - h / 2 };
  if (inForeignZone(postRect(spot))) {
    spot = findFreeSpot(spot.x, spot.y, w, h, foreignZones());
    if (!spot) {
      toast("Здесь всё занято чужими зонами — сдвиньте стену");
      return;
    }
  }
  ui.postSubmit.disabled = true;
  try {
    const post = await api.createPost(text, round1(spot.x), round1(spot.y));
    addPost(post);
    ui.postDialog.close();
    revealPost(post);
  } catch (err) {
    toast(err.message);
  } finally {
    ui.postSubmit.disabled = false;
  }
}

function openViewDialog(post) {
  state.viewPostId = post.id;
  ui.viewText.textContent = post.text;
  ui.viewMeta.textContent = `${post.is_mine ? "Ваш пост" : "Пост"} · ${formatTime(post.created_at)}`;
  ui.viewDelete.hidden = !post.is_mine;
  ui.viewDialog.showModal();
}

async function deleteViewedPost() {
  const id = state.viewPostId;
  if (!id || !window.confirm("Удалить этот пост со стены?")) return;
  try {
    await api.deletePost(id);
    state.posts.delete(id);
    rebuildOrder();
    updateEmptyState();
    ui.viewDialog.close();
    requestDraw();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Режимы и панели ----------

function setMode(mode) {
  cancelGesture();
  state.mode = mode;
  for (const button of document.querySelectorAll(".tool")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  ui.drawPanel.hidden = mode !== "draw";
  ui.zonePanel.hidden = mode !== "zone";
  document.body.classList.toggle("has-panel", mode !== "move");
  state.hoverPostId = null;
  canvas.style.cursor = mode === "move" ? "default" : "crosshair";
  updateZoneFree();
  requestDraw();
}

function buildSwatches() {
  for (const color of DRAW_COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.style.background = color;
    button.dataset.color = color;
    button.title = color;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", `Цвет ${color}`);
    button.addEventListener("click", () => setColor(color));
    ui.swatches.append(button);
  }
}

function setColor(color) {
  state.color = color.toLowerCase();
  ui.colorInput.value = state.color;
  for (const button of ui.swatches.querySelectorAll(".swatch")) {
    button.setAttribute("aria-checked", String(button.dataset.color === state.color));
  }
}

function setThickness(value) {
  state.thickness = clamp(Math.round(Number(value) || cfg.default_thickness), cfg.min_thickness, cfg.max_thickness);
  ui.thicknessInput.value = String(state.thickness);
  ui.thicknessValue.textContent = String(state.thickness);
}

function applyConfigToUi() {
  ui.postText.maxLength = cfg.max_text_length;
  ui.thicknessInput.min = String(cfg.min_thickness);
  ui.thicknessInput.max = String(cfg.max_thickness);
  setThickness(cfg.default_thickness);
  setColor(cfg.default_color);
  updateCounter();
}

function setOnline(online) {
  ui.netDot.classList.toggle("offline", !online);
  ui.netDot.title = online ? "Связь с сервером есть" : "Нет связи с сервером";
}

async function copyLink() {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Ссылка на это место стены скопирована", "info");
  } catch {
    window.prompt("Скопируйте ссылку:", location.href);
  }
}

function onKeyDown(e) {
  if (!state.loaded || document.querySelector("dialog[open]")) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!spaceDown) {
      spaceDown = true;
      if (!gesture) canvas.style.cursor = "grab";
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
    if (state.mode === "draw") {
      e.preventDefault();
      undoLastLine();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.code) {
    case "KeyV": setMode("move"); break;
    case "KeyD": setMode("draw"); break;
    case "KeyZ": setMode("zone"); break;
    case "KeyN":
      e.preventDefault();
      openPostDialog();
      break;
    case "Escape":
      if (gesture) cancelGesture();
      else setMode("move");
      break;
    case "Digit0":
    case "Home":
      centerOn(0, 0, 1);
      break;
    case "Equal":
    case "NumpadAdd":
      zoomAt(viewW / 2, viewH / 2, 1.2);
      break;
    case "Minus":
    case "NumpadSubtract":
      zoomAt(viewW / 2, viewH / 2, 1 / 1.2);
      break;
    default:
      break;
  }
}

function onKeyUp(e) {
  if (e.code !== "Space") return;
  spaceDown = false;
  if (!gesture) canvas.style.cursor = state.mode === "move" ? "default" : "crosshair";
}

function bindUi() {
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => { spaceDown = false; });
  window.addEventListener("hashchange", () => {
    const target = readHash();
    if (target) centerOn(target.x, target.y, target.scale);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.loaded) poll();
  });
  // Кнопки не держат фокус, иначе пробел (обзор стены) будет их «нажимать».
  document.addEventListener("click", (e) => {
    const button = e.target instanceof Element ? e.target.closest("button") : null;
    if (button && !button.closest("dialog")) button.blur();
  });

  for (const button of document.querySelectorAll(".tool")) {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  }
  $("#add-post-btn").addEventListener("click", () => {
    if (state.loaded) openPostDialog();
  });
  $("#home-btn").addEventListener("click", () => centerOn(0, 0, 1));
  $("#share-btn").addEventListener("click", copyLink);
  $("#help-btn").addEventListener("click", () => ui.helpDialog.showModal());
  $("#help-close").addEventListener("click", () => ui.helpDialog.close());
  $("#draw-done").addEventListener("click", () => setMode("move"));
  $("#zone-done").addEventListener("click", () => setMode("move"));
  $("#undo-btn").addEventListener("click", undoLastLine);
  ui.colorInput.addEventListener("input", () => setColor(ui.colorInput.value));
  ui.thicknessInput.addEventListener("input", () => setThickness(ui.thicknessInput.value));

  ui.postForm.addEventListener("submit", submitPost);
  ui.postText.addEventListener("input", updateCounter);
  ui.postText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ui.postForm.requestSubmit();
  });
  $("#post-cancel").addEventListener("click", () => ui.postDialog.close());
  $("#view-close").addEventListener("click", () => ui.viewDialog.close());
  ui.viewDelete.addEventListener("click", deleteViewedPost);
  ui.viewDialog.addEventListener("close", () => { state.viewPostId = null; });
}

// ---------- Синхронизация ----------

// Без WebSocket: опрашиваем сервер раз в несколько секунд, ETag экономит трафик.
async function poll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (polling || document.hidden) return;
  polling = true;
  try {
    const result = await api.wall(state.etag);
    if (!result.notModified) {
      state.etag = result.etag;
      applyWall(result.data);
    }
    setOnline(true);
  } catch {
    setOnline(false);
  } finally {
    polling = false;
    if (!document.hidden) pollTimer = setTimeout(poll, cfg.poll_interval_seconds * 1000);
  }
}

function jumpToContentIfViewEmpty() {
  if (!state.posts.size) return;
  const view = viewRect();
  for (const post of state.posts.values()) {
    if (rectsIntersect(postRect(post), view)) return;
  }
  const newest = [...state.posts.values()].reduce((a, b) => (timeOf(b) > timeOf(a) ? b : a));
  centerOn(newest.x + cfg.post_width / 2, newest.y + cfg.post_height / 2);
}

async function init() {
  buildSwatches();
  bindUi();
  resize();
  const fromHash = readHash();
  if (fromHash) centerOn(fromHash.x, fromHash.y, fromHash.scale);
  else centerOn(0, 0, 1);

  const slowHint = setTimeout(() => { ui.loadingHint.hidden = false; }, 2500);
  for (let attempt = 1; ; attempt++) {
    try {
      Object.assign(cfg, await api.config());
      try {
        await ensureSession();
      } catch (err) {
        // Без сессии стену всё равно можно смотреть; регистрация повторится при первом действии.
        console.warn("Анонимная регистрация не удалась:", err.message);
      }
      const result = await api.wall(null);
      state.etag = result.etag;
      state.loaded = true;
      applyWall(result.data);
      break;
    } catch (err) {
      ui.loadingText.textContent = `Не удалось загрузить стену: ${err.message}. Пробуем ещё раз…`;
      await sleep(Math.min(10000, 1500 * attempt));
    }
  }
  clearTimeout(slowHint);
  ui.loading.hidden = true;
  applyConfigToUi();
  if (!fromHash) jumpToContentIfViewEmpty();
  setOnline(true);
  pollTimer = setTimeout(poll, cfg.poll_interval_seconds * 1000);
}

init();
