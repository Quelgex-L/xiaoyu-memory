// conflict：同 canonical_key 矛盾检测，标记待确认，不静默覆盖。
// 语义：旧记忆保持 active（不隐身），新记忆置 conflict 并进入"待确认"区。
import { findByCanonicalKey, updateMemory } from "../store/meta-db.js";

// 简单启发式：新值与旧值在同一 canonical_key 下，标题/摘要关键词明显对立。
// 注意顺序：先匹配"否定式"，否则"不喜欢"会被"喜欢"吞掉。
const CONTRADICTION_PAIRS = [
  ["喜欢", "不喜欢"],
  ["想", "不想"],
  ["爱", "不爱"],
  ["要", "不要"],
  ["同意", "反对"],
  ["结婚", "离婚"],
  ["记得", "忘了"],
  ["喜欢", "讨厌"],
  ["爱", "恨"],
  ["是", "不是"],
];

// 同一稳定键下，这类记忆一旦改口就值得找用户确认
const CONFIRM_TYPES = ["preference", "identity", "boundary", "relationship"];

function detectContradiction(oldText, newText) {
  const o = String(oldText || "").toLowerCase();
  const n = String(newText || "").toLowerCase();
  for (const [p, q] of CONTRADICTION_PAIRS) {
    if (o.includes(p) && n.includes(q)) return true;
    if (o.includes(q) && n.includes(p)) return true;
  }
  return false;
}

function normalize(t) {
  return String(t || "").toLowerCase().replace(/[\s。，、！？!?,.~～:：;；"'“”‘’（）()【】\[\]…—-]/g, "");
}

export function checkConflict(newMemory) {
  if (!newMemory.canonical_key) return { conflict: false };
  const existing = findByCanonicalKey(newMemory.canonical_key, newMemory.id);
  for (const old of existing) {
    // 只有仍在生效的旧记忆才可能构成冲突；已 superseded/archived 的不再参与
    if (old.status !== "active") continue;
    const oldText = `${old.title} ${old.summary || ""}`;
    const newText = `${newMemory.title} ${newMemory.summary || ""}`;

    if (detectContradiction(oldText, newText)) {
      return {
        conflict: true,
        oldId: old.id,
        oldText,
        newText,
        kind: "contradiction",
        message: `检测到与旧记忆矛盾：旧说「${old.title}」，新说「${newMemory.title}」。需要你确认以哪个为准。`,
      };
    }

    // 改口类：同一稳定键、同属偏好/身份/边界/关系，标题又明显不同 → 也进待确认区，不静默合并
    if (
      CONFIRM_TYPES.includes(old.type) &&
      CONFIRM_TYPES.includes(newMemory.type) &&
      normalize(old.title) !== normalize(newMemory.title)
    ) {
      return {
        conflict: true,
        oldId: old.id,
        oldText,
        newText,
        kind: "revised",
        message: `新说法与旧记忆口径不同：旧记「${old.title}」，新记「${newMemory.title}」。需要确认以哪个为准。`,
      };
    }
  }
  return { conflict: false };
}

export function markConflict(oldId, newId, note) {
  updateMemory(oldId, { status: "conflict", conflict_with: newId, conflict_note: note });
  updateMemory(newId, { status: "conflict", conflict_with: oldId, conflict_note: note });
}

export function resolveConflict(keepId, dropId) {
  updateMemory(keepId, { status: "active", conflict_with: null, conflict_note: null });
  updateMemory(dropId, { status: "superseded", conflict_with: null, conflict_note: null });
}
