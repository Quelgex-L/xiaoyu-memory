#!/usr/bin/env node
// 导出星图数据：从 SQLite 读节点与无向边，生成 galaxy-data.json 供 galaxy.html 使用。
// 修复点：边改用 allLinks() 单次读取（原实现按节点 linksOf 会重复计边）；
//         亮度运算符优先级；数值取整以缩小 JSON。
import { openDb, listMemories, allLinks } from "../store/meta-db.js";
import { writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";

export function exportGalaxy() {
  const cfg = getConfig();
  openDb();

  const memories = listMemories({ status: "active" });
  const nodes = memories.map((m) => {
    const daysSinceAccess = (Date.now() - m.last_access) / 86400000;
    const recency = Math.exp(-daysSinceAccess / 30);
    const base = m.salience * 0.4 + recency * 0.3 + Math.min(m.access_count, 10) / 10 * 0.15 + Math.abs(m.valence || 0) * 0.15;
    const brightness = base * (m.pinned ? 1.0 : 0.7);
    return {
      id: m.id,
      title: m.title,
      summary: m.summary || "",
      type: m.type,
      mood: m.mood || "",
      valence: round(m.valence || 0, 2),
      salience: round(m.salience, 2),
      access_count: m.access_count,
      last_access: m.last_access,
      created_at: m.created_at,
      source: m.source || "",
      tags: m.tags,
      pinned: m.pinned,
      brightness: round(Math.max(0.15, Math.min(1, brightness)), 2),
    };
  });

  // 无向边：links 表里每条边只存一行，直接读全量即可，不会再重复
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = allLinks()
    .filter((l) => nodeIds.has(l.src_id) && nodeIds.has(l.dst_id))
    .map((l) => ({ src: l.src_id, dst: l.dst_id, rel: l.rel, weight: round(l.weight, 2) }));

  const out = { nodes, edges, generated_at: Date.now() };
  const outPath = join(cfg.vectorRoot, "galaxy-data.json");
  const jsPath = join(cfg.vectorRoot, "galaxy-data.js");
  const htmlPath = join(cfg.vectorRoot, "galaxy.html");
  writeFileSync(outPath, JSON.stringify(out));
  // 同步写一份 JS 版本：浏览器直接打开 html（file://）时 fetch 会被拦，脚本标签不会
  writeFileSync(jsPath, `window.XIAOYU_GALAXY = ${JSON.stringify(out)};\n`);
  // 把包内 3D 页面复制到数据目录旁边，保证 file:// 双击能读到同目录数据
  const pkgHtml = join(cfg.pkgRoot, "src", "web", "galaxy.html");
  if (existsSync(pkgHtml)) copyFileSync(pkgHtml, htmlPath);
  return { outPath, jsPath, htmlPath, nodes: nodes.length, edges: edges.length };
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round((Number(v) || 0) * k) / k;
}

// 直接执行时导出
if (import.meta.url === `file://${process.argv[1]}`) {
  const res = exportGalaxy();
  console.log(`星图数据已导出: ${res.outPath}`);
  console.log(`可直接打开的版本: ${res.jsPath}`);
  console.log(`节点: ${res.nodes}, 边: ${res.edges}`);
}
