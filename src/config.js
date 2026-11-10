// 配置加载：读取包内 config.json，路径展开 ~，合并默认值。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

const DEFAULTS = {
  memoryRoot: "~/.dsh/whale-soul/memory",
  vectorDir: "vector",
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    embeddingModel: "nomic-embed-text",
    embedDimension: 768,
    taskModel: "qwen2.5:7b",
    timeoutMs: 30000,
  },
  recall: {
    topK: 8,
    weights: { vector: 0.55, tag: 0.25, recency: 0.1, salience: 0.1 },
    pinnedBoost: 2.0,
  },
  emotion: {
    immediateWindowMs: 86400000,
    longWindowsMs: [86400000, 604800000, 2592000000],
    valenceRange: [-1, 1],
    arousalRange: [0, 1],
  },
  forgetting: {
    defaultHalfLifeDays: 30,
    salientHalfLifeDays: 180,
    coreHalfLifeDays: 3650,
    archiveThreshold: 0.1,
    coldThreshold: 0.3,
  },
  triggers: [],
  coreTopics: ["relationship", "preference", "promise", "identity", "boundary"],
  consolidation: { idleMs: 300000, checkIntervalMs: 900000, maxWritesPerRun: 40 },
  backfill: { dryRun: true, batchSize: 50 },
};

function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function deepMerge(base, override) {
  if (!override) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let cached = null;

export function loadConfig(overridePath) {
  if (cached && !overridePath) return cached;
  let userConfig = {};
  const candidates = [
    overridePath,
    join(PKG_ROOT, "config.json"),
    expandHome("~/.dsh/xiaoyu-memory/config.json"),
  ].filter(Boolean);
  for (const c of candidates) {
    const p = expandHome(c);
    if (existsSync(p)) {
      try {
        userConfig = JSON.parse(readFileSync(p, "utf8"));
        break;
      } catch (e) {
        console.warn(`[xiaoyu-memory] 配置读取失败 ${p}:`, e.message);
      }
    }
  }
  const merged = deepMerge(DEFAULTS, userConfig);
  merged.memoryRoot = expandHome(merged.memoryRoot);
  merged.vectorRoot = join(merged.memoryRoot, merged.vectorDir);
  merged.pkgRoot = PKG_ROOT;
  cached = merged;
  return merged;
}

export function getConfig() {
  return cached || loadConfig();
}

export function resetConfigCache() {
  cached = null;
}
