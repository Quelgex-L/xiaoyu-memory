#!/usr/bin/env node
// 自测脚本：全部跑在临时目录，绝不碰真实记忆库。
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resetConfigCache, getConfig } from "./config.js";
import {
  openDb, insertMemory, listMemories, closeDb, upsertTrigger, upsertLink, allLinks,
  allTriggers, emotionEventsSince, getMemory,
} from "./store/meta-db.js";
import { upsertVector, save as saveVectors, vectorCount, indexMeta, allVectors } from "./store/vector-index.js";
import { embed, checkOllama } from "./store/embedding.js";
import { recall } from "./engine/recall.js";
import { recordEmotion, immediateMood, longTrend, inferEmotion, emotionContextSummary } from "./engine/emotion.js";
import { checkConflict, resolveConflict } from "./engine/conflict.js";
import { handleTriggerInput, seedTriggers } from "./engine/triggers.js";
import { extractCandidates, fingerprint, classify } from "./engine/extract.js";
import { exportGalaxy } from "./engine/build-galaxy.js";
import { runConsolidation } from "./engine/consolidation.js";
import { migrateLegacy } from "./engine/migrate-legacy.js";
import { writeMemory } from "./index.js";

let pass = 0, fail = 0;
function assert(name, cond, detail = "") {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

const ROOT = mkdtempSync(join(tmpdir(), "xiaoyu-mem-selftest-"));
console.log(`=== 小瑜记忆系统自测（隔离目录 ${ROOT}）===\n`);

try {
  // 0. 配置必须落在临时目录，带上配置触发词
  const cfgPath = join(ROOT, "config.json");
  writeFileSync(cfgPath, JSON.stringify({
    memoryRoot: join(ROOT, "memory"),
    vectorDir: "vector",
    triggers: [
      { word: "小瑜", group: "persona", linkedTags: ["identity", "persona", "relationship"] },
      { word: "鲸鱼娘", group: "persona", linkedTags: ["identity", "persona"] },
    ],
  }));
  resetConfigCache();
  const cfg = loadConfig(cfgPath);
  assert("配置加载到临时目录", cfg.memoryRoot.startsWith(ROOT), cfg.memoryRoot);
  assert("不会写真实库", !cfg.memoryRoot.includes("whale-soul"));

  // 1. Ollama 状态只做提示
  const ollamaOk = await checkOllama();
  console.log(`  ℹ️ Ollama embedding: ${ollamaOk ? "可用" : "降级为哈希向量"}`);

  // 2. embedding 必须带语义空间标记
  const vec = await embed("主人喜欢奶茶三分糖");
  assert("embedding 返回向量", Array.isArray(vec) && vec.length > 100);
  assert("向量带 space 标记", typeof vec.space === "string" && vec.space.length > 0, String(vec.space));

  // 3. 规则抽取
  const cand = extractCandidates({ userText: "我喜欢吃草莓蛋糕" });
  assert("抽取到偏好类记忆", cand.length === 1 && cand[0].type === "preference", JSON.stringify(cand[0]?.type));
  assert("偏好归一化 canonical_key", cand[0]?.canonical_key === "pref:草莓蛋糕", cand[0]?.canonical_key);
  assert("闲聊不入库", extractCandidates({ userText: "好的" }).length === 0);
  assert("系统提示词不入库", extractCandidates({ userText: "<system-reminder>xxx</system-reminder>" }).length === 0);
  assert("指纹稳定", fingerprint("我喜欢吃草莓蛋糕") === fingerprint("我喜欢吃草莓蛋糕！"));

  // 3b. 规则情绪推断
  const pos = inferEmotion("今天好开心，很期待见面");
  const neg = inferEmotion("我好难过，好累，压力很大");
  assert("正面情绪效价为正", pos.valence > 0, String(pos.valence));
  assert("负面情绪效价为负", neg.valence < 0, String(neg.valence));

  // 4. 存储层
  openDb();
  const m1 = insertMemory({
    title: "我喜欢奶茶",
    summary: "偏好：奶茶三分糖少冰",
    type: "preference",
    tags: ["preference", "milk-tea"],
    canonical_key: "pref:奶茶",
    salience: 0.8,
    pinned: true,
    source: "self-test",
  });
  assert("插入记忆", m1.id.startsWith("mem_"));
  assert("pinned 记忆", m1.pinned === true);

  // 5. 写入路径 + 冲突：旧记忆保持 active，新记忆进 conflict
  const written = await writeMemory({
    title: "我不喜欢奶茶",
    summary: "现在不爱喝奶茶了",
    type: "preference",
    tags: ["preference"],
    canonical_key: "pref:奶茶",
    salience: 0.7,
    source: "self-test",
  });
  const oldAfter = listMemories({ status: "active" }).find((m) => m.id === m1.id);
  assert("冲突时旧记忆仍可召回", !!oldAfter);
  assert("冲突时新记忆进待确认", written?.memory?.status === "conflict", written?.memory?.status);
  assert("冲突检测命中", written?.conflict?.oldId === m1.id);

  // 5b. 写入时情绪事件落库（即时通道）
  const emotionRows = emotionEventsSince(0);
  assert("写入产生情绪事件", emotionRows.length >= 1, String(emotionRows.length));

  // 6. 显式解决冲突
  resolveConflict(m1.id, written.memory.id);
  const resolved = listMemories().find((m) => m.id === written.memory.id);
  assert("解决冲突后新记忆被取代", resolved?.status === "superseded", resolved?.status);

  // 7. 召回
  upsertVector(m1.id, await embed(`${m1.title} ${m1.summary}`));
  saveVectors();
  const totalKeys = Object.keys(allVectors()).length;
  assert("__meta 不计入向量数", vectorCount() === totalKeys - 1, `${vectorCount()} / ${totalKeys}`);
  assert("索引记录了语义空间", !!indexMeta()?.model, JSON.stringify(indexMeta()));
  const results = await recall("上次说的奶茶那个事");
  assert("召回返回结果", results.length > 0);
  assert("召回到奶茶记忆", results.some((r) => r.title.includes("奶茶")));

  // 8. 情绪双层
  recordEmotion({ memory_id: m1.id, mood: "开心", valence: 0.7, arousal: 0.5, source: "test" });
  recordEmotion({ memory_id: m1.id, mood: "期待", valence: 0.8, arousal: 0.6, source: "test" });
  const imm = immediateMood();
  assert("即时情绪有记录", imm && imm.count >= 2);
  const trend = longTrend();
  assert("长期情绪窗口", trend["24h"] && trend["7d"]);
  assert("情绪趋势上下文非空", emotionContextSummary().includes("24h"));

  // 9. 暗号：配置种子 + 命中召回
  const seeded = seedTriggers();
  assert("配置触发词全部入库", allTriggers().length === 2, String(allTriggers().length));
  const trig = handleTriggerInput("小瑜你好呀");
  assert("暗号触发命中", trig && trig.trigger.word === "小瑜");
  const trig2 = handleTriggerInput("鲸鱼娘在吗");
  assert("第二个暗号命中", trig2 && trig2.trigger.word === "鲸鱼娘");

  // 10. 整理：同名重复应被合并
  insertMemory({ title: "重复的一句话", summary: "a", type: "note", salience: 0.4, source: "self-test" });
  insertMemory({ title: "重复的一句话", summary: "b", type: "note", salience: 0.6, source: "self-test" });
  const clog = await runConsolidation();
  const dupLeft = listMemories({ status: "active" }).filter((m) => m.title === "重复的一句话");
  assert("重复记忆被合并", clog.merged >= 1 && dupLeft.length === 1, `merged=${clog.merged}, left=${dupLeft.length}`);

  // 11. 星图导出：边不重复（必须两端都是 active 节点）
  const m3 = insertMemory({
    title: "小瑜是鲸鱼娘",
    summary: "身份：住在 DSH 里的鲸类少女",
    type: "identity",
    tags: ["identity", "persona"],
    salience: 0.95,
    source: "self-test",
  });
  upsertLink(m1.id, m3.id, "semantic", 0.9);
  assert("links 表只有一行", allLinks().length === 1, String(allLinks().length));
  const galaxy = exportGalaxy();
  assert("星图边不重复计数", galaxy.edges === 1, String(galaxy.edges));
  assert("星图节点非空", galaxy.nodes >= 1, String(galaxy.nodes));

  // 12. 遗留迁移：dry-run 先预览，再真实落库，幂等不重复
  const vecRoot = getConfig().vectorRoot;
  writeFileSync(join(vecRoot, "galaxy-data.json"), JSON.stringify({
    nodes: [
      { id: "mem_legacy_1", title: "旧遗留记忆一", summary: "迁移测试", type: "fact", mood: "", valence: 0.2, salience: 0.6, access_count: 1, last_access: 1794192982487, created_at: 1794192201407, source: "legacy", tags: ["fact"], pinned: false, brightness: 0.4 },
    ],
    edges: [{ src: "mem_legacy_1", dst: m3.id, rel: "semantic", weight: 0.7 }],
  }));
  writeFileSync(join(vecRoot, "vectors.json"), JSON.stringify({
    __meta: { model: "nomic-embed-text", dim: 768, since: 1794198060776 },
    mem_legacy_1: new Array(768).fill(0.01),
  }));
  const dry = await migrateLegacy({ dryRun: true });
  assert("遗留迁移 dry-run 计数", dry.imported === 1 && dry.linked === 1, JSON.stringify(dry));
  const real = await migrateLegacy({ dryRun: false });
  assert("遗留记忆真实入库", !!getMemory("mem_legacy_1"));
  assert("遗留向量并入索引", Array.isArray(allVectors()["mem_legacy_1"]));
  const again = await migrateLegacy({ dryRun: false });
  assert("遗留迁移幂等（二次跳过）", again.skipped === 1, JSON.stringify(again));

  closeDb();
} finally {
  closeDb();
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
