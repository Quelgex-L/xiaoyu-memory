// embedding 层：优先 Ollama nomic-embed-text；不可用时降级为本地哈希向量。
import { getConfig } from "../config.js";

let ollamaAvailable = null; // null=未探测 true/false
let cachedDimension = null;

// 确定性 char n-gram 哈希到指定维度（降级用）
function hashVector(text, dim) {
  const vec = new Float64Array(dim);
  if (!text) return vec;
  const s = String(text).toLowerCase();
  // 1-gram 与 2-gram
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    vec[ch % dim] += 1;
    if (i < s.length - 1) {
      const bi = (ch * 31 + s.charCodeAt(i + 1)) % dim;
      vec[bi] += 0.5;
    }
  }
  // L2 归一
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

export async function checkOllama() {
  if (ollamaAvailable !== null) return ollamaAvailable;
  const cfg = getConfig();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${cfg.ollama.baseUrl}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const hasEmbed = (data.models || []).some(
      (m) => m.name === cfg.ollama.embeddingModel || m.name.startsWith(cfg.ollama.embeddingModel)
    );
    ollamaAvailable = hasEmbed;
    return ollamaAvailable;
  } catch (e) {
    ollamaAvailable = false;
    return false;
  }
}

export async function embed(text) {
  const cfg = getConfig();
  const useOllama = await checkOllama();
  if (useOllama) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.ollama.timeoutMs);
      const r = await fetch(`${cfg.ollama.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.ollama.embeddingModel, prompt: String(text || "") }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const v = data.embedding;
      if (Array.isArray(v) && v.length > 0) {
        cachedDimension = v.length;
        const out = normalize(v);
        out.space = cfg.ollama.embeddingModel; // 语义空间标记
        return out;
      }
    } catch (e) {
      // 降级
      ollamaAvailable = false;
    }
  }
  // 降级：哈希向量（与 embedding 不在同一空间，调用方必须区分）
  const dim = cachedDimension || cfg.ollama.embedDimension;
  const out = Array.from(hashVector(text, dim));
  out.space = "hash";
  return out;
}

export function normalize(arr) {
  const v = Array.isArray(arr) ? new Float64Array(arr) : arr;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 双方都已归一化
}

export async function runTaskPrompt(prompt) {
  // 本地杂活模型调用：记忆抽取、情绪标注、冲突语义判断
  const cfg = getConfig();
  const useOllama = await checkOllama();
  if (!useOllama) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.ollama.timeoutMs * 2);
    const r = await fetch(`${cfg.ollama.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.ollama.taskModel,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 512 },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    return data.response || null;
  } catch (e) {
    return null;
  }
}

export function resetHealthCache() {
  ollamaAvailable = null;
  cachedDimension = null;
}
