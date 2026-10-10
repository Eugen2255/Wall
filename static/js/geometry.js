// Геометрия стены. Повторяет app/geometry.py, чтобы интерфейс сразу
// подсказывал, где чужая приватная зона, не дожидаясь ответа сервера.

export function rectsIntersect(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

export function expandRect(r, d) {
  return { x1: r.x1 - d, y1: r.y1 - d, x2: r.x2 + d, y2: r.y2 + d };
}

export function normalizeRect(ax, ay, bx, by) {
  return { x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) };
}

export function rectArea(r) {
  return (r.x2 - r.x1) * (r.y2 - r.y1);
}

export function pointInRect(x, y, r) {
  return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
}

// Отсечение Лианга — Барски: есть ли у отрезка общая точка с прямоугольником.
export function segmentIntersectsRect(ax, ay, bx, by, r) {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const edges = [[-dx, ax - r.x1], [dx, r.x2 - ax], [-dy, ay - r.y1], [dy, r.y2 - ay]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

export function polylineIntersectsRect(points, r) {
  if (points.length === 1) return pointInRect(points[0][0], points[0][1], r);
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    if (segmentIntersectsRect(ax, ay, bx, by, r)) return true;
  }
  return false;
}

export function polylineBounds(points, pad = 0) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of points) {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
}

// Упрощение Рамера — Дугласа — Пекера (итеративное, без рекурсии).
function rdp(points, epsilon) {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const [ax, ay] = points[start];
    const [bx, by] = points[end];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxDist = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = points[i];
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (index !== -1 && maxDist > epsilon) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Сокращает линию до maxPoints точек, постепенно огрубляя упрощение.
export function simplifyPolyline(points, maxPoints, epsilon) {
  let eps = epsilon;
  let result = rdp(points, eps);
  while (result.length > maxPoints) {
    eps *= 1.5;
    result = rdp(points, eps);
  }
  return result;
}

// Ищет по спирали ближайшее к (x, y) место для стикера w×h вне blockers.
export function findFreeSpot(x, y, w, h, blockers, step = 40, maxRings = 60) {
  const fits = (cx, cy) => !blockers.some((b) => rectsIntersect({ x1: cx, y1: cy, x2: cx + w, y2: cy + h }, b));
  if (fits(x, y)) return { x, y };
  for (let ring = 1; ring < maxRings; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const cx = x + dx * step;
        const cy = y + dy * step;
        if (fits(cx, cy)) return { x: cx, y: cy };
      }
    }
  }
  return null;
}
