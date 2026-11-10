// consolidation：空闲整理（梦境）——合并近似重复、降级过期、归档淡化。
import { getConfig } from "../config.js";
import { listMemories, updateMemory, getMeta, setMeta } from "../store/meta-db.js";
import { fingerprint } from "./extract.js";

const STATS_KEY = "last_consolidation_log";

function normalizeTitle(t) {
  return String(t || "").toLowerCase().replace(/[\s。，、！？!?,.~～:：;；"'“”‘’（）()【】\[\]…—-]/g, "");
}

function betterOne(a, b) {
  // 重要度高的留下；同等重要度留更早那条（第一次说出来的版本）
  if (a.salience !== b.salience) return a.salience > b.salience ? a : b;
  return a.created_at <= b.created_at ? a : b;
}

export async function runConsolidation() {
  const cfg = getConfig();
  const log = { merged: 0, downgraded: 0, archived: 0, ts: Date.now() };
  const active = listMemories({ status: "active" });
  const budget = cfg.consolidation.maxWritesPerRun || 40;
  let wrote = 0;

  // 1) 近似重复合并：标题指纹 + canonical_key 两个维度
  const dropped = new Set();
  const groups = new Map();
  for (const m of active) {
    if (m.pinned) continue;
    const keys = [];
    const fp = fingerprint(m.title);
    if (fp) keys.push(`t:${fp}`);
    if (m.canonical_key) keys.push(`c:${m.canonical_key}`);
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
  }
  for (const [key, members] of groups) {
    // canonical_key 同组要保守：只在偏好/身份这类"一说就定"的类别里合并
    if (key.startsWith("c:")) {
      const types = new Set(members.map((m) => m.type));
      if (![...types].every((t) => ["preference", "identity", "boundary"].includes(t))) continue;
    }
    if (members.length < 2 || wrote >= budget) continue;
    const alive = members.filter((m) => !dropped.has(m.id));
    if (alive.length < 2) continue;

    let keep = alive[0];
    for (const m of alive.slice(1)) keep = betterOne(keep, m);
    for (const m of alive) {
      if (m.id === keep.id) continue;
      updateMemory(m.id, { status: "superseded", conflict_note: `合并自 ${keep.title}` });
      dropped.add(m.id);
      log.merged++;
      wrote++;
    }
    // 合并后把访问次数累加到保留者
    if (wrote <= budget) {
      const extra = alive.reduce((s, m) => (m.id === keep.id ? s : s + (m.access_count || 0)), 0);
      if (extra) updateMemory(keep.id, { access_count: (keep.access_count || 0) + extra });
    }
  }

  // 2) 半衰期降级：按 retrievability 降到 cold / archived
  const nowMs = Date.now();
  for (const m of active) {
    if (m.pinned || dropped.has(m.id) || wrote >= budget * 2) continue;
    const halfLife = m.half_life_days || cfg.forgetting.defaultHalfLifeDays;
    const daysSinceUpdate = (nowMs - m.last_access) / 86400000;
    const retrievability = Math.pow(0.5, daysSinceUpdate / halfLife);
    if (retrievability < cfg.forgetting.archiveThreshold) {
      updateMemory(m.id, { status: "archived" });
      log.archived++;
      wrote++;
    } else if (retrievability < cfg.forgetting.coldThreshold) {
      updateMemory(m.id, { salience: Math.max(0.1, m.salience * 0.8) });
      log.downgraded++;
      wrote++;
    }
  }

  setMeta(STATS_KEY, JSON.stringify(log));
  return log;
}

export function lastLog() {
  const raw = getMeta(STATS_KEY);
  return raw ? JSON.parse(raw) : null;
}

// 简易空闲调度器
export function startIdleTimer(onIdle) {
  const cfg = getConfig();
  let lastActivity = Date.now();
  const interval = setInterval(() => {
    if (Date.now() - lastActivity > cfg.consolidation.idleMs) {
      lastActivity = Date.now(); // 防重复触发
      onIdle().catch((e) => console.warn("[xiaoyu-memory] 空闲整理失败:", e));
    }
  }, cfg.consolidation.checkIntervalMs);
  interval.unref?.(); // 不阻止进程退出
  return {
    ping: () => { lastActivity = Date.now(); },
    stop: () => clearInterval(interval),
  };
}
