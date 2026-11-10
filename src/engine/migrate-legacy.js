#!/usr/bin/env node
// migrate-legacy：把 whale-soul 旧遗留层（galaxy-data.json + vectors.json + 旧边）
// 幂等迁入新元数据库与向量索引。默认 dry-run，先看计数再决定是否真正写入。
// 已存在的 id 跳过，不覆盖新库已有状态；首次真实导入前备份旧文件。
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig, resetConfigCache } from "../config.js";
import { openDb, getMemory, insertMemory, updateMemory, upsertLink, allLinks, setMeta, getMeta } from "../store/meta-db.js";
import { upsertVector, save as saveVectors, indexMeta, setIndexMeta, allVectors } from "../store/vector-index.js";

const BACKUP_TAG = "legacy-import-backup";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export async function migrateLegacy({ dryRun = true } = {}) {
  const cfg = getConfig();
  openDb();

  const galaxyPath = join(cfg.vectorRoot, "galaxy-data.json");
  const vectorsPath = join(cfg.vectorRoot, "vectors.json");
  const legacy = readJson(galaxyPath, { nodes: [], edges: [] });
  const legacyVectors = readJson(vectorsPath, {});

  const nodes = Array.isArray(legacy.nodes) ? legacy.nodes : [];
  const edges = Array.isArray(legacy.edges) ? legacy.edges : [];
  const vecEntries = Object.entries(legacyVectors).filter(([k]) => !k.startsWith("__"));

  const result = { dryRun, nodes: nodes.length, edges: edges.length, vectors: vecEntries.length, imported: 0, skipped: 0, linked: 0, vectorImported: 0 };

  // 真实导入前备份旧遗留文件
  if (!dryRun) {
    const backupDir = join(cfg.memoryRoot, "_backup", BACKUP_TAG);
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(galaxyPath)) copyFileSync(galaxyPath, join(backupDir, "galaxy-data.json"));
    if (existsSync(vectorsPath)) copyFileSync(vectorsPath, join(backupDir, "vectors.json"));
  }

  for (const node of nodes) {
    if (!node?.id) continue;
    if (getMemory(node.id)) { result.skipped++; continue; }

    const entry = {
      id: node.id,
      type: node.type || "note",
      title: node.title || "(无标题)",
      summary: node.summary || "",
      tags: Array.isArray(node.tags) ? node.tags : [],
      valence: node.valence ?? null,
      arousal: null,
      mood: node.mood || null,
      salience: node.salience ?? 0.5,
      pinned: !!node.pinned,
      source: node.source || "legacy",
      provenance: "legacy-import",
      half_life_days: 180,
      layers: "gist",
    };

    if (dryRun) { result.imported++; continue; }

    const inserted = insertMemory(entry);
    updateMemory(inserted.id, {
      created_at: node.created_at || Date.now(),
      updated_at: node.created_at || Date.now(),
      last_access: node.last_access || node.created_at || Date.now(),
      access_count: node.access_count || 0,
    });
    result.imported++;
  }

  // 旧边迁入 links 表
  const existingPairs = new Set(allLinks().map((l) => `${l.src_id}|${l.dst_id}|${l.rel}`));
  for (const e of edges) {
    if (!e?.src || !e?.dst) continue;
    const key = `${e.src}|${e.dst}|${e.rel || "semantic"}`;
    if (existingPairs.has(key)) continue;
    if (!dryRun) upsertLink(e.src, e.dst, e.rel || "semantic", e.weight ?? 1);
    result.linked++;
  }

  // 旧向量并入索引（768 维 nomic 空间）
  const meta = indexMeta();
  if (!meta?.model) setIndexMeta({ model: "nomic-embed-text", dim: 768, since: Date.now(), note: "legacy-import" });
  for (const [id, vec] of vecEntries) {
    if (!Array.isArray(vec) || !vec.length) continue;
    const existing = allVectors()[id];
    if (Array.isArray(existing) && existing.length === vec.length) continue;
    if (!dryRun) upsertVector(id, vec);
    result.vectorImported++;
  }

  if (!dryRun) {
    saveVectors();
    setMeta("legacy_imported", String(result.imported));
  }
  return result;
}

// 直接执行：默认 dry-run；传 --write 才真正落库
if (import.meta.url === `file://${process.argv[1]}`) {
  resetConfigCache();
  const write = process.argv.includes("--write");
  const res = await migrateLegacy({ dryRun: !write });
  console.log(`[migrate-legacy] ${write ? "真实导入" : "dry-run 预览"}:`, JSON.stringify(res, null, 2));
  if (!write) console.log("确认无误后加 --write 落库。");
}
