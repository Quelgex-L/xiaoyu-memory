#!/usr/bin/env node
// export-backup：把元数据库的记忆、关联边、暗号触发词导出为一份 JSON 备份。
// 回滚：删除 ~/.dsh/whale-soul/memory/vector/ 即回到纯 whale-soul 状态；
// 需要恢复时把本备份里的 memories/links/triggers 重新写回 meta.sqlite 即可。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { openDb, listMemories, allLinks, allTriggers, getMeta } from "../store/meta-db.js";

export function exportBackup() {
  const cfg = getConfig();
  openDb();
  const payload = {
    exported_at: Date.now(),
    memories: listMemories(),
    links: allLinks(),
    triggers: allTriggers(),
    meta: { backfill_cursor: getMeta("backfill_cursor"), legacy_imported: getMeta("legacy_imported") },
  };
  mkdirSync(cfg.vectorRoot, { recursive: true });
  const path = join(cfg.vectorRoot, `backup-memories-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return { path, memories: payload.memories.length, links: payload.links.length, triggers: payload.triggers.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = exportBackup();
  console.log(`备份完成: ${res.path}`);
  console.log(`记忆 ${res.memories} 条 · 边 ${res.links} 条 · 暗号 ${res.triggers} 条`);
}
