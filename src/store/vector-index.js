// vector-index：纯 JS 余弦相似度索引。
// 向量存在内存里，定期持久化到 vector-root/vectors.json。
// 千级记忆、768 维，O(N*dim) 检索完全够用。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig } from "../config.js";
import { cosineSimilarity } from "./embedding.js";

let store = null; // { [id]: number[] }

function indexPath() {
  const cfg = getConfig();
  const p = join(cfg.vectorRoot, "vectors.json");
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

function load() {
  if (store) return store;
  const p = indexPath();
  if (existsSync(p)) {
    try {
      store = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      store = {};
    }
  } else {
    store = {};
  }
  return store;
}

export function save() {
  if (!store) return;
  writeFileSync(indexPath(), JSON.stringify(store));
}

export function upsertVector(id, vec) {
  const s = load();
  s[id] = vec;
  // 不立即 save，由调用方在批处理后统一 save
}

export function removeVector(id) {
  const s = load();
  delete s[id];
}

// 索引元信息：记录向量来自哪个语义空间（模型名 / 哈希降级），避免混用
const META_KEY = "__meta";

export function indexMeta() {
  return load()[META_KEY] || null;
}

export function setIndexMeta(meta) {
  load()[META_KEY] = meta;
}

export function nearest(queryVec, topK = 8, filterIds = null) {
  const s = load();
  const isVec = (id) => !id.startsWith("__") && Array.isArray(s[id]);
  const candidates = filterIds && filterIds.size > 0
    ? [...filterIds].filter(isVec)
    : Object.keys(s).filter(isVec);
  const scored = [];
  for (const id of candidates) {
    const v = s[id];
    if (!v || v.length !== queryVec.length) continue;
    scored.push({ id, score: cosineSimilarity(queryVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function vectorCount() {
  const s = load();
  return Object.keys(s).filter((id) => !id.startsWith("__") && Array.isArray(s[id])).length;
}

export function allVectors() {
  return load();
}
