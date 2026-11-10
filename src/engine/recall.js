// recall：混合召回 = 向量相似度 + 标签/文本重合 + 时间近因 + 重要度。
import { getConfig } from "../config.js";
import { listMemories, touchMemory } from "../store/meta-db.js";
import { nearest, indexMeta } from "../store/vector-index.js";
import { embed } from "../store/embedding.js";

// 字面重合的候选门槛：低于此值视为"只是碰巧有同样的字"，不入围
const GRAM_GATE = 0.25;

// 中文没有空格，整串 includes 永远命中不了；改用字级 bigram 重合度
function bigrams(text) {
  const clean = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  if (clean.length === 1) set.add(clean);
  return set;
}

function gramOverlap(qGrams, text) {
  if (!qGrams.size) return 0;
  const target = bigrams(text);
  let hit = 0;
  for (const g of qGrams) if (target.has(g)) hit++;
  return hit / qGrams.size;
}

// 标签命中：查询词（或 bigram）出现在标签里的比例
function tagOverlap(tags, qGrams, queryText) {
  if (!tags || !tags.length) return 0;
  const text = String(queryText || "").toLowerCase();
  let hit = 0;
  for (const tag of tags) {
    const t = String(tag).toLowerCase();
    if (!t) continue;
    if (text.includes(t)) hit += 1;
    else {
      const tg = bigrams(t);
      for (const g of tg) if (qGrams.has(g)) { hit += 0.5; break; }
    }
  }
  return Math.min(1, hit / Math.max(1, Math.min(tags.length, 4)));
}

function recencyScore(updatedAt, nowMs) {
  const days = (nowMs - updatedAt) / 86400000;
  return Math.exp(-days / 30); // 30 天半衰期
}

export async function recall(query, opts = {}) {
  const cfg = getConfig();
  const nowMs = Date.now();
  const active = listMemories({ status: "active", space: opts.space || "owner" });
  if (!active.length) return [];

  const qGrams = bigrams(query);

  // 1) 向量候选：只有语义空间一致时才可用，否则跳过（不拿哈希向量比 embedding）
  const qVec = await embed(query);
  const meta = indexMeta();
  const spaceOk = !meta?.model || meta.model === (qVec?.space || meta.model);
  const vecMap = new Map();
  if (spaceOk && qVec.length) {
    for (const hit of nearest(qVec, Math.max(cfg.recall.topK * 5, 60))) vecMap.set(hit.id, hit.score);
  }

  // 2) 文本候选：标题/摘要/标签的 bigram 重合（门槛提高，避免"两个""意思"这类泛词入围）
  const gramScores = new Map();
  for (const m of active) {
    const text = `${m.title} ${m.summary || ""} ${m.tags.join(" ")}`;
    const score = gramOverlap(qGrams, text);
    if (score >= GRAM_GATE) gramScores.set(m.id, score);
  }
  const gramTop = [...gramScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([id]) => id);

  // 3) 合并候选集
  const candidateIds = new Set([...vecMap.keys(), ...gramTop]);
  const candidates = active.filter((m) => candidateIds.has(m.id) || m.pinned);

  // 4) 打分
  const w = cfg.recall.weights;
  const scored = candidates.map((m) => {
    const vecScore = vecMap.get(m.id) || 0;
    const gramScore = gramScores.get(m.id) || 0;
    const tagScore = Math.max(tagOverlap(m.tags, qGrams, query), gramScore);
    const recScore = recencyScore(m.updated_at, nowMs);
    const salScore = m.salience || 0.5;
    let total =
      w.vector * vecScore +
      w.tag * tagScore +
      w.recency * recScore +
      w.salience * salScore;
    if (m.pinned) total *= cfg.recall.pinnedBoost;
    return { memory: m, score: total, vecScore, gramScore };
  });

  scored.sort((a, b) => b.score - a.score);
  // 硬过滤：真正有信号才返回（向量够近 / 字面重合够高 / pinned），否则宁可不注入
  const kept = scored.filter((s) => s.vecScore >= 0.35 || s.gramScore >= GRAM_GATE || s.memory.pinned);
  const topScore = kept[0]?.score || 0;
  const floor = Math.max(0.12, topScore * 0.5);
  const top = kept.filter((s) => s.score >= floor).slice(0, cfg.recall.topK);

  for (const s of top) touchMemory(s.memory.id);

  return top.map((s) => ({
    id: s.memory.id,
    title: s.memory.title,
    summary: s.memory.summary,
    time: s.memory.updated_at,
    mood: s.memory.mood,
    valence: s.memory.valence,
    salience: s.memory.salience,
    source: s.memory.source,
    score: s.score,
    tags: s.memory.tags,
    pinned: s.memory.pinned,
  }));
}

export function buildMemoryContext(results) {
  if (!results || !results.length) return "";
  const lines = results.map((r) => {
    const d = new Date(r.time);
    const date = `${d.getMonth() + 1}月${d.getDate()}日`;
    const mark = r.pinned ? "★ " : "";
    return `- [${date}] ${mark}${r.title}${r.summary ? "：" + r.summary : ""}`;
  });
  return `【相关记忆】\n${lines.join("\n")}`;
}
