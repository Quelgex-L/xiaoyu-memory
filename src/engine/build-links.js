#!/usr/bin/env node
// 自动建边：向量近邻 + 共享标签。
// 关键改动：
//   1. 不再用固定 0.75 —— nomic 对中文短句的中位相似度就有 0.70，固定阈值会让全图连成毛球
//   2. 每节点只保留 top-K 近邻 + 自适应阈值（均值+2.5σ），边数可控
//   3. 重建前清空旧的派生边，避免历史脏边残留
//   4. 语义空间不一致时不补生成哈希向量
import { openDb, listMemories, upsertLink, allLinks } from "../store/meta-db.js";
import { upsertVector, allVectors, save as saveVectors, indexMeta } from "../store/vector-index.js";
import { embed, cosineSimilarity, checkOllama } from "../store/embedding.js";

const TOP_K = 5;          // 每个节点最多保留的近邻数
const MIN_SIM = 0.88;     // 绝对下限（低于此值一律不连）
const SIGMA_K = 2.0;      // 自适应阈值：mean + SIGMA_K * std

openDb();
const memories = listMemories({ status: "active" });
console.log(`为 ${memories.length} 条记忆建边...`);

// ---------- 1. 补齐向量（只允许在同一语义空间内补） ----------
const meta = indexMeta();
const space = meta?.model || null;
let vecCount = 0;
let spaceBlocked = false;
for (const m of memories) {
  const vecs = allVectors();
  if (Array.isArray(vecs[m.id])) continue;
  if (spaceBlocked) continue;
  const vec = await embed(`${m.title} ${m.summary || ""}`);
  if (space && vec.space !== space) {
    spaceBlocked = true;
    console.warn(`[build-links] 跳过向量补齐：索引空间 ${space}，当前 ${vec.space}（Ollama 未运行，先启动再重建）`);
    continue;
  }
  upsertVector(m.id, vec);
  vecCount++;
}
if (vecCount) saveVectors();
console.log(`新生成向量: ${vecCount}`);

// ---------- 2. 两两比较，收集候选 ----------
const vecs = allVectors();
const pairs = [];
let sum = 0, sumSq = 0, n = 0;
for (let i = 0; i < memories.length; i++) {
  const a = memories[i];
  if (!Array.isArray(vecs[a.id])) continue;
  for (let j = i + 1; j < memories.length; j++) {
    const b = memories[j];
    if (!Array.isArray(vecs[b.id])) continue;
    const sim = cosineSimilarity(vecs[a.id], vecs[b.id]);
    // 统计全量分布，但只为可能过阈值的对保留候选，避免 33 万对数组撑爆内存
    if (sim >= MIN_SIM) pairs.push([i, j, sim]);
    sum += sim; sumSq += sim * sim; n++;
  }
}

// ---------- 3. 自适应阈值 ----------
const mean = n ? sum / n : 0;
const std = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
const cutoff = Math.max(MIN_SIM, mean + SIGMA_K * std);
console.log(`候选 ${n} 对，均值 ${mean.toFixed(3)}，标准差 ${std.toFixed(3)}，阈值 ${cutoff.toFixed(3)}`);

// ---------- 4. 只保留 top-K 近邻 ----------
pairs.sort((x, y) => y[2] - x[2]);
const deg = new Map();
const kept = [];
for (const [i, j, sim] of pairs) {
  if (sim < cutoff) break;
  const a = memories[i].id, b = memories[j].id;
  if ((deg.get(a) || 0) >= TOP_K) continue;
  if ((deg.get(b) || 0) >= TOP_K) continue;
  deg.set(a, (deg.get(a) || 0) + 1);
  deg.set(b, (deg.get(b) || 0) + 1);
  kept.push([a, b, sim]);
}

// ---------- 5. 清空派生边后重建 ----------
const db = openDb();
db.prepare("DELETE FROM links WHERE rel IN ('semantic','tag')").run();
for (const [a, b, sim] of kept) upsertLink(a, b, "semantic", sim);

let tagCount = 0;
for (let i = 0; i < memories.length; i++) {
  const a = memories[i];
  for (let j = i + 1; j < memories.length; j++) {
    const b = memories[j];
    const shared = (a.tags || []).filter((t) => (b.tags || []).includes(t) && t !== "note");
    if (shared.length >= 2) {
      upsertLink(a.id, b.id, "tag", shared.length / Math.max(a.tags.length, b.tags.length));
      tagCount++;
    }
  }
}

console.log(`建边完成: semantic ${kept.length} 条, tag ${tagCount} 条, 相邻节点平均度 ${(kept.length * 2 / Math.max(1, memories.length)).toFixed(1)}`);
