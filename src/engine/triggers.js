// triggers：暗号触发词，命中后召回整组关联记忆。
// 启动时把 config.json 里配置的暗号幂等写入 triggers 表。
import { allTriggers, upsertTrigger, listMemories } from "../store/meta-db.js";
import { getConfig } from "../config.js";

// 幂等种子：配置里有、库里没有就补；配置里删掉的不主动删库（保留用户手工加的）。
export function seedTriggers() {
  const cfg = getConfig();
  const configured = Array.isArray(cfg.triggers) ? cfg.triggers : [];
  for (const t of configured) {
    if (!t || !t.word) continue;
    upsertTrigger(t.word, t.group || "persona", t.linkedTags || t.linked_tags || [], []);
  }
  return allTriggers();
}

export function detectTrigger(text) {
  const triggers = allTriggers();
  const lower = String(text || "").toLowerCase();
  for (const t of triggers) {
    if (lower.includes(t.word.toLowerCase())) {
      return t;
    }
  }
  return null;
}

export function recallByTrigger(trigger) {
  if (!trigger) return [];
  // 1) 直接关联的记忆 ID
  let results = [];
  if (trigger.linked_memory_ids && trigger.linked_memory_ids.length) {
    const all = listMemories({ status: "active" });
    results = all.filter((m) => trigger.linked_memory_ids.includes(m.id));
  }
  // 2) 按 linked_tags 补召回
  if (trigger.linked_tags && trigger.linked_tags.length) {
    const all = listMemories({ status: "active" });
    for (const m of all) {
      if (results.find((r) => r.id === m.id)) continue;
      if (m.tags && m.tags.some((t) => trigger.linked_tags.includes(t))) {
        results.push(m);
      }
    }
  }
  return results;
}

export function handleTriggerInput(text) {
  const t = detectTrigger(text);
  if (!t) return null;
  const memories = recallByTrigger(t);
  return { trigger: t, memories };
}
