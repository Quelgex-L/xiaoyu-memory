// emotion：双层情绪——即时事件流 + 长期窗口聚合。
// 第一层：当下这一轮的情绪标注（规则词典，不依赖模型）。
// 第二层：24h / 7d / 30d 窗口聚合效价、唤醒度与压力倾向。
import { getConfig } from "../config.js";
import { insertEmotionEvent, emotionEventsSince, emotionEventMemoryIds, listMemories } from "../store/meta-db.js";

// ---------- 规则情绪推断（写入时调用，产出 mood / valence / arousal） ----------

const POSITIVE_WORDS = [
  ["开心", 0.75], ["高兴", 0.75], ["快乐", 0.7], ["喜欢", 0.65], ["爱", 0.7],
  ["期待", 0.7], ["想你", 0.75], ["在乎", 0.65], ["满足", 0.6], ["幸运", 0.55],
  ["棒", 0.55], ["好耶", 0.7], ["嘿嘿", 0.5], ["笑", 0.5], ["安心", 0.45],
];
const NEGATIVE_WORDS = [
  ["难过", -0.75], ["伤心", -0.75], ["生气", -0.8], ["讨厌", -0.6], ["烦", -0.55],
  ["累", -0.4], ["压力", -0.6], ["焦虑", -0.65], ["害怕", -0.6], ["担心", -0.5],
  ["失望", -0.65], ["孤独", -0.6], ["郁闷", -0.55], ["不爽", -0.55], ["恨", -0.7],
  ["委屈", -0.6], ["紧张", -0.5], ["不喜欢", -0.5],
];
const HIGH_AROUSAL = ["激动", "愤怒", "惊喜", "生气", "期待", "好耶", "紧张", "害怕"];
const LOW_AROUSAL = ["平静", "疲惫", "累", "困", "难过", "安静", "放松"];

export function inferEmotion(text) {
  const t = String(text || "");
  if (!t.trim()) return { mood: "平静", valence: 0.15, arousal: 0.45 };

  let valence = 0.15;
  let mood = "平静";
  let posHit = null, negHit = null;
  for (const [w, v] of POSITIVE_WORDS) {
    if (t.includes(w)) { posHit = { w, v }; break; }
  }
  for (const [w, v] of NEGATIVE_WORDS) {
    if (t.includes(w)) { negHit = { w, v }; break; }
  }
  if (posHit) { valence = posHit.v; mood = posHit.w; }
  if (negHit) { valence = negHit.v; mood = negHit.w; }
  if (posHit && negHit) valence = posHit.v + negHit.v >= 0 ? 0.2 : -0.2;

  let arousal = 0.5;
  if (HIGH_AROUSAL.some((w) => t.includes(w))) arousal = 0.75;
  else if (LOW_AROUSAL.some((w) => t.includes(w))) arousal = 0.3;

  return { mood, valence: Number(valence.toFixed(2)), arousal: Number(arousal.toFixed(2)) };
}

export function recordEmotion({ memory_id, mood, valence, arousal, source }) {
  // 边界约束
  const cfg = getConfig();
  const v = Math.max(cfg.emotion.valenceRange[0], Math.min(cfg.emotion.valenceRange[1], valence ?? 0));
  const a = Math.max(cfg.emotion.arousalRange[0], Math.min(cfg.emotion.arousalRange[1], arousal ?? 0.5));
  insertEmotionEvent({ memory_id, mood, valence: v, arousal: a, source, ts: Date.now() });
  return { mood, valence: v, arousal: a };
}

export function immediateMood() {
  const cfg = getConfig();
  const since = Date.now() - cfg.emotion.immediateWindowMs;
  const events = emotionEventsSince(since);
  if (!events.length) return null;
  return aggregate(events);
}

export function longTrend() {
  const cfg = getConfig();
  const out = {};
  for (const [idx, ms] of cfg.emotion.longWindowsMs.entries()) {
    const since = Date.now() - ms;
    const events = emotionEventsSince(since);
    out[["24h", "7d", "30d"][idx]] = aggregate(events);
  }
  return out;
}

function aggregate(events) {
  if (!events.length) return { count: 0, dominantMood: null, avgValence: 0, avgArousal: 0, pressure: 0 };
  let v = 0, a = 0;
  const moodCount = {};
  for (const e of events) {
    v += e.valence || 0;
    a += e.arousal || 0.5;
    if (e.mood) moodCount[e.mood] = (moodCount[e.mood] || 0) + 1;
  }
  const n = events.length;
  const avgV = v / n;
  const avgA = a / n;
  // 压力倾向：高唤醒 + 负效价
  const pressure = Math.max(0, avgA * (1 - avgV));
  let dominant = null;
  let max = 0;
  for (const [m, c] of Object.entries(moodCount)) if (c > max) { max = c; dominant = m; }
  return { count: n, dominantMood: dominant, avgValence: Number(avgV.toFixed(2)), avgArousal: Number(avgA.toFixed(2)), pressure: Number(pressure.toFixed(2)) };
}

// 为已有记忆补齐情绪事件：旧库里记忆没有情绪事件流，长期趋势会是空的。
// 幂等：已有事件的 memory_id 跳过；缺情绪标注的用规则词典从标题/摘要推断。
export function backfillEmotionEvents() {
  const existing = emotionEventMemoryIds();
  const memories = listMemories();
  let inserted = 0;
  for (const m of memories) {
    if (!m.id || existing.has(m.id)) continue;
    const inferred = inferEmotion(`${m.title || ""} ${m.summary || ""}`);
    insertEmotionEvent({
      memory_id: m.id,
      mood: m.mood || inferred.mood,
      valence: m.valence ?? inferred.valence,
      arousal: m.arousal ?? inferred.arousal,
      source: "legacy-derive",
      ts: m.created_at || Date.now(),
    });
    inserted++;
  }
  return { inserted, total: memories.length };
}

// 注入 system prompt 的长期情绪段：只取 7d 与 30d 趋势，避免太碎。
export function emotionContextSummary() {
  const trend = longTrend();
  const parts = [];
  for (const win of ["24h", "7d", "30d"]) {
    const t = trend[win];
    if (!t || t.count === 0) continue;
    const v = t.avgValence;
    const tone = v > 0.25 ? "偏积极" : v < -0.25 ? "偏低落" : "平稳";
    const pressure = t.pressure > 0.5 ? "，压力感偏高" : "";
    parts.push(`${win}（${t.count} 条）：${tone}，主导情绪「${t.dominantMood || "平静"}」${pressure}`);
  }
  if (!parts.length) return "";
  return `【近期情绪状态】\n${parts.join("\n")}`;
}
