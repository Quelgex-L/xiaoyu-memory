// extract：从一轮真实对话里判断"值不值得记"，并抽出可入库的记忆条目。
// 纯规则实现，不依赖 Ollama；实时写入与历史回填共用同一套判定。
import { createHash } from "node:crypto";
import { inferEmotion } from "./emotion.js";

// ---------- 文本清洗 ----------

export function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

const SYSTEM_PREFIXES = [
  "<system-reminder>",
  "Current working directory",
  "Current DSH",
  "Approval prompts",
  "A skill is",
  "You are ",
  "<user-preferences>",
  "<agent-workspace>",
];

const GREETINGS = new Set([
  "你好", "您好", "hello", "hi", "在吗", "在不在", "早上好", "中午好", "晚上好",
  "晚安", "再见", "拜拜", "谢谢", "thanks", "ok", "好的", "好", "收到", "嗯",
  "嗯嗯", "哈哈", "hhh", "哈", "？", "?", "怎么了", "没事", "算了",
]);

function stripPunctuation(text) {
  return String(text || "").replace(/[\s。，、！？!?,.~～:：;；"'“”‘’（）()【】\[\]…—-]/g, "");
}

export function isWorthRemembering(text, { minLength = 6, maxLength = 2000 } = {}) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length < minLength || t.length > maxLength) return false;
  if (SYSTEM_PREFIXES.some((p) => t.startsWith(p))) return false;
  if (t.includes("tool_call_id") || t.includes("tool_call")) return false;
  const bare = stripPunctuation(t).toLowerCase();
  if (!bare) return false;
  if (GREETINGS.has(bare)) return false;
  // 纯标点/纯表情/纯重复字符
  if (/^[\p{Emoji}\u200d\ufe0f]+$/u.test(bare)) return false;
  if (new Set(bare).size <= 1) return false;
  return true;
}

// ---------- 标题与指纹 ----------

export function makeTitle(text, max = 30) {
  const first = String(text || "").split(/[。！？\n.!?]/)[0] || String(text || "");
  const clean = first.trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

export function fingerprint(text) {
  const norm = stripPunctuation(String(text || "")).toLowerCase().slice(0, 120);
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

// ---------- 分类 ----------

const RULES = [
  { type: "identity", tags: ["identity"], salience: 0.9,
    test: /我叫|我是|我的名字|我住在|我今年|我今年|我的生日|我在(读|做|学)/ },
  { type: "boundary", tags: ["boundary"], salience: 0.85,
    test: /(不要|别|不准|不许|禁止|不能)(再)?(这样|那么|这么)?(对我|跟我|叫我|说|提|碰|动)/ },
  { type: "preference", tags: ["preference"], salience: 0.75,
    test: /我喜欢|我不喜欢|我讨厌|我偏好|我爱吃|我爱喝|我习惯|我对.{0,8}(过敏|不耐受)|我想吃|我要喝/ },
  { type: "promise", tags: ["promise"], salience: 0.7,
    test: /(约定|答应|说好|讲好|约好|下周|下个月|明天|后天|周末|考试|截止|deadline)/ },
  { type: "relationship", tags: ["relationship"], salience: 0.7,
    test: /喜欢你|爱你|想你|在乎你|我们之间|陪着你|离不开/ },
  { type: "work", tags: ["work"], salience: 0.5,
    test: /(项目|代码|bug|部署|重构|服务器|数据库|论文|报告|面试|offer|客户|需求)/ },
];

const PREFERENCE_PATTERNS = [
  { re: /我喜欢(?!你|你|上你|吃你)[^，。！？\n]{1,16}/, polarity: "like" },
  { re: /我不喜欢[^，。！？\n]{1,16}/, polarity: "dislike" },
  { re: /我讨厌[^，。！？\n]{1,16}/, polarity: "dislike" },
  { re: /我爱吃[^，。！？\n]{1,16}/, polarity: "like" },
  { re: /我爱喝[^，。！？\n]{1,16}/, polarity: "like" },
];

// 把"我喜欢奶茶三分糖"归一成 "pref:奶茶三分糖"，让同一对象的新旧说法落到同一 key
function preferenceKey(text) {
  for (const { re, polarity } of PREFERENCE_PATTERNS) {
    const m = String(text || "").match(re);
    if (m) {
      const object = m[0].replace(/^我(不)?(喜欢|讨厌|爱吃|爱喝)/, "").replace(/^[吃喝]/, "").replace(/了|过/g, "").trim();
      if (object) return { key: `pref:${object}`, polarity };
    }
  }
  return null;
}

export function classify(text) {
  const t = String(text || "");
  const tags = [];
  let type = "note";
  let salience = 0.35;
  for (const rule of RULES) {
    if (!rule.test.test(t)) continue;
    tags.push(...rule.tags);
    if (rule.salience > salience || type === "note") {
      type = rule.type;
      salience = Math.max(salience, rule.salience);
    }
  }
  const pref = preferenceKey(t);
  if (pref) {
    if (!tags.includes("preference")) tags.push("preference");
    if (type === "note") { type = "preference"; salience = Math.max(salience, 0.75); }
  }
  return {
    type,
    tags: tags.length ? [...new Set(tags)] : ["note"],
    salience,
    canonical_key: pref ? pref.key : null,
  };
}

// ---------- 一轮对话 → 候选记忆 ----------

// 只把用户的陈述入库；助手的话只作为上下文，不进记忆。
export function extractCandidates({ userText, at = Date.now(), source = "live", maxEntries = 2 } = {}) {
  if (!isWorthRemembering(userText)) return [];
  const cls = classify(userText);
  // 闲聊（note）且不长，不入库，避免把"继续""好呀"堆进记忆
  if (cls.type === "note" && userText.trim().length < 40) return [];

  const emotion = inferEmotion(userText);
  return [{
    title: makeTitle(userText),
    summary: userText.trim().slice(0, 200),
    type: cls.type,
    tags: cls.tags,
    canonical_key: cls.canonical_key,
    salience: cls.salience,
    source,
    provenance: source === "live" ? "conversation" : "backfill-user",
    half_life_days: cls.type === "identity" ? 365 : cls.type === "preference" ? 180 : 30,
    mood: emotion.mood,
    valence: emotion.valence,
    arousal: emotion.arousal,
    created_hint: at,
  }].slice(0, maxEntries);
}
