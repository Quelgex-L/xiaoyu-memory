// 插件入口：把召回注入 system prompt，并在每轮对话结束后异步写记忆。
// 上下文注入走宿主成熟契约（与 dsh-whale-soul / dsh-roost 一致）：
//   ctx.systemPrompt.context({ name, order, required, interpolate, text })
//   text() 由宿主每轮同步调用；向量/语义召回是异步的，先在 user/message 时预计算并缓存，
//   text() 只读缓存，避免在同步回调里阻塞。
// 事件契约：
//   session/event (session, event) → user/message、assistant/message、turn/end
//   session/disposed (session) → 清理会话级缓存
// 工具注册：tools 按官方契约声明进 inject（宿主缺服务时插件保持 inactive，而不是在
// apply 中途抛 "without inject"）；读取统一走 ctx.reflect.get 安全探测，插件级优先、agent.ctx 兜底。
import { loadConfig } from "./config.js";
import { openDb, insertMemory, listMemories, getMemory } from "./store/meta-db.js";
import { upsertVector, save as saveVectors, indexMeta, setIndexMeta } from "./store/vector-index.js";
import { embed, checkOllama } from "./store/embedding.js";
import { recall, buildMemoryContext } from "./engine/recall.js";
import { checkConflict, resolveConflict } from "./engine/conflict.js";
import { seedTriggers, handleTriggerInput } from "./engine/triggers.js";
import { startIdleTimer, runConsolidation } from "./engine/consolidation.js";
import { extractCandidates, textOfContent, fingerprint } from "./engine/extract.js";
import { recordEmotion, immediateMood, longTrend, emotionContextSummary } from "./engine/emotion.js";

export const name = "xiaoyu-memory";
// systemPrompt、tools 均为宿主成熟服务（与同机正常工作的 whale-soul 写法一致）。
// 可选服务写进 inject：宿主缺某服务时 Cordis 让插件保持 inactive，不会在 apply 中途抛错。
export const inject = ["systemPrompt", "tools"];

const CONTEXT_NAME = "xiaoyu:recall";

// 会话级临时状态：本轮用户输入、本轮助手文本、已入库指纹
const inputs = new Map();      // sessionId -> 最近一条用户文本
const replies = new Map();      // sessionId -> 本轮助手文本（流式累加）
const seen = { set: null };    // 已入库标题指纹

// 异步召回结果缓存：text() 同步回调里只能读缓存，不能再 await
const recallCache = { sid: null, text: "" };

function sessionIdOf(session) {
  return session?.header?.id ?? session?.id ?? null;
}

function loadSeen() {
  if (seen.set) return seen.set;
  const active = listMemories({ status: "active" });
  seen.set = new Set(active.map((m) => fingerprint(m.title)));
  return seen.set;
}

// 召回加超时护栏：Ollama 卡住时不能拖住整个回复
async function recallWithTimeout(text, ms = 2500) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve([]), ms); });
  try {
    return await Promise.race([recall(text), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// 异步预计算召回结果，写进缓存；上下文 text() 同步回调只读缓存
async function refreshRecallCache(sid, userText) {
  try {
    const trig = handleTriggerInput(userText);
    const results = trig && trig.memories.length
      ? trig.memories.map((m) => ({
          id: m.id, title: m.title, summary: m.summary, time: m.updated_at,
          mood: m.mood, valence: m.valence, salience: m.salience, source: m.source,
          score: 1.0, tags: m.tags,
        }))
      : await recallWithTimeout(userText);
    recallCache.sid = sid;
    recallCache.text = results && results.length ? buildMemoryContext(results) : "";
  } catch (e) {
    console.warn("[xiaoyu-memory] 召回缓存刷新失败:", e.message);
  }
}

// 上下文块正文：召回缓存 + 待确认冲突 + 长期情绪趋势（均为同步可读）
function buildContextText() {
  const parts = [];
  if (recallCache.text) parts.push(recallCache.text);
  const conflicts = listMemories({ status: "conflict" });
  if (conflicts.length) parts.push(buildConflictContext(conflicts));
  const emotionSummary = emotionContextSummary();
  if (emotionSummary) parts.push(emotionSummary);
  return parts.filter(Boolean).join("\n\n");
}

// 兼容有无 ctx.effect 的宿主；有 effect 时保证随插件卸载清理
function hook(ctx, name, fn, tag) {
  if (typeof ctx.effect === "function") {
    ctx.effect(() => ctx.on(name, fn), `xiaoyu-memory.${tag}`);
    return;
  }
  ctx.on?.(name, fn);
}

// 安全读取 tools 服务：优先 reflect.get（绕过 inject 校验，缺服务返回 undefined），
// 再退直接属性；整体包 try/catch，避免在 Cordis 代理上下文里触发未注入 getter 抛错。
function toolsOf(ctxx) {
  if (!ctxx) return null;
  try {
    if (typeof ctxx.reflect?.get === "function") {
      return ctxx.reflect.get("tools", false) || null;
    }
  } catch {
    /* 继续退化到直接读取 */
  }
  return ctxx.tools ?? null;
}

export async function apply(ctx, config = {}) {
  loadConfig(config.configPath);
  openDb();
  seedTriggers();

  const ollamaReady = await checkOllama();
  if (ollamaReady) {
    console.log("[xiaoyu-memory] 启动完成：Ollama embedding 可用，向量检索 + 自动写入全开");
  } else {
    console.log("[xiaoyu-memory] 启动完成：Ollama 未运行 → 检索退化为字面匹配，新记忆暂不写向量（启动后跑 npm run links 补齐）");
  }

  let idle = null;

  // 1) 召回 / 冲突 / 情绪上下文：注册一个宿主每轮同步调用的上下文块。
  //    与 whale-soul 的 ctx.systemPrompt.context(...) 同一契约；text() 同步，
  //    异步召回结果在 user/message 时预计算进 recallCache。
  const registerContext = () => {
    if (typeof ctx.systemPrompt?.context !== "function") {
      console.warn("[xiaoyu-memory] 未发现 systemPrompt.context 服务，召回上下文未挂载");
      return;
    }
    ctx.systemPrompt.context({
      name: CONTEXT_NAME,
      order: 240,
      required: true,
      interpolate: false,
      text: buildContextText,
    });
  };
  if (typeof ctx.effect === "function") ctx.effect(registerContext, "xiaoyu-memory.context()");
  else registerContext();

  // 2) 采集输入与回复，一轮结束后异步写入
  hook(ctx, "session/event", (session, event) => {
    try {
      const sid = sessionIdOf(session);
      if (!sid || !event?.type) return;
      idle?.ping();

      if (event.type === "user/message") {
        if (event.data?.source?.kind !== "user") return;
        const text = textOfContent(event.data?.content);
        if (text) {
          inputs.set(sid, text);
          replies.set(sid, "");
          // 异步预计算本轮召回，供上下文 text() 同步读取
          void refreshRecallCache(sid, text);
        } else {
          inputs.delete(sid);
        }
        return;
      }

      if (event.type === "assistant/message") {
        const text = textOfContent(event.data?.message?.content);
        if (text) replies.set(sid, (replies.get(sid) || "") + "\n" + text);
        return;
      }

      if (event.type === "turn/end") {
        const reason = event.data?.reason?.kind;
        const userText = inputs.get(sid);
        const replyText = replies.get(sid) || "";
        replies.delete(sid);
        inputs.delete(sid);
        if (!userText) return;
        if (reason && reason !== "completed") return;
        queueWrite({ sid, userText, replyText });
      }
    } catch (e) {
      console.warn("[xiaoyu-memory] session/event 处理失败:", e.message);
    }
  }, "events()");

  // 3) 会话清理
  hook(ctx, "session/disposed", (session) => {
    const sid = sessionIdOf(session);
    if (!sid) return;
    inputs.delete(sid);
    replies.delete(sid);
    if (recallCache.sid === sid) recallCache.text = "";
  }, "session-disposed()");

  // 4) 注册模型可调用工具：插件级 tools 优先，agent.ctx.tools 兜底；都缺就跳过，不影响启动
  const registeredTools = new Set();
  const registerTools = (registry) => {
    if (!registry?.register) return;
    for (const def of buildToolDefs()) {
      if (registeredTools.has(def.name)) continue;
      try { registry.register(def); registeredTools.add(def.name); }
      catch (e) { console.warn("[xiaoyu-memory] 工具注册失败:", def.name, e.message); }
    }
  };
  registerTools(toolsOf(ctx));
  hook(ctx, "agent/created", async ({ agent }) => registerTools(toolsOf(agent?.ctx)), "tools()");

  // 5) 暴露手动 API（通过 Cordis provide 注册服务）
  const api = {
    remember: async (entry) => await writeMemory(entry),
    recall: async (q, opts) => await recall(q, opts),
    consolidate: async () => await runConsolidation(),
    conflicts: () => listMemories({ status: "conflict" }),
    resolve: (keepId, dropId) => resolveConflict(keepId, dropId),
    emotion: () => ({ immediate: immediateMood(), trend: longTrend() }),
    status: () => ({
      ollamaReady,
      memories: listMemories({ status: "active" }).length,
      pendingConflicts: listMemories({ status: "conflict" }).length,
      vectorSpace: indexMeta()?.model || (ollamaReady ? "unknown" : "hash"),
    }),
  };
  if (typeof ctx.provide === "function") {
    const disposeService = ctx.provide("xiaoyuMemory", api);
    ctx.effect?.(() => (typeof disposeService === "function" ? disposeService : () => {}), "xiaoyu-memory.dispose()");
  } else {
    try { ctx.xiaoyuMemory = api; } catch { /* 代理上下文不允许直接挂属性，忽略 */ }
  }

  // 6) 空闲整理调度
  idle = startIdleTimer(() => runConsolidation());
  idle.ping();
}

// ---------- 模型可调用工具定义 ----------

const TEXT_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
};

function buildToolDefs() {
  return [
    {
      name: "xiaoyu_recall",
      description: "按关键词或模糊描述检索小瑜的长期记忆，返回相关记忆条目。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词或一句模糊的描述。" },
        },
        required: ["query"],
      },
      output: { schema: TEXT_OUTPUT, render: () => [] },
      async execute(args) {
        const results = await recall(String(args?.query || ""));
        if (!results.length) return { text: "没有找到相关的长期记忆。" };
        const lines = results.map((r) => `- ${r.title}${r.summary ? "：" + r.summary : ""}`);
        return { text: lines.join("\n") };
      },
    },
    {
      name: "xiaoyu_resolve_conflict",
      description: "在用户明确确认以哪条为准后，解决一条待确认的记忆冲突：保留 keep_id 对应记忆，废弃 drop_id 对应记忆。",
      parameters: {
        type: "object",
        properties: {
          keep_id: { type: "string", description: "保留的记忆 id。" },
          drop_id: { type: "string", description: "废弃的记忆 id。" },
        },
        required: ["keep_id", "drop_id"],
      },
      output: { schema: TEXT_OUTPUT, render: () => [] },
      async execute(args) {
        const keep = getMemory(args?.keep_id);
        const drop = getMemory(args?.drop_id);
        if (!keep || !drop) return { text: "冲突记忆不存在，未做改动。" };
        resolveConflict(keep.id, drop.id);
        return { text: `已保留「${keep.title}」，废弃「${drop.title}」。` };
      },
    },
    {
      name: "xiaoyu_remember",
      description: "手动写入一条长期记忆。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "一句话标题。" },
          summary: { type: "string", description: "要记住的正文，1–3 句。" },
          type: { type: "string", description: "记忆类型：preference/identity/boundary/promise/relationship/fact/note。" },
          tags: { type: "array", items: { type: "string" }, description: "检索标签。" },
        },
        required: ["title"],
      },
      output: { schema: TEXT_OUTPUT, render: () => [] },
      async execute(args) {
        const written = await writeMemory({
          title: String(args?.title || ""),
          summary: String(args?.summary || ""),
          type: args?.type || "fact",
          tags: Array.isArray(args?.tags) ? args.tags : [],
        });
        if (!written) return { text: "没有可写入的内容。" };
        return { text: written.conflict ? `已记录，但与旧记忆存在冲突，待确认：${written.conflict.message}` : "记下了。" };
      },
    },
  ];
}

// ---------- 写入队列 ----------

const writeQueue = [];
let writing = false;

function queueWrite(task) {
  writeQueue.push(task);
  drainWrites().catch((e) => console.warn("[xiaoyu-memory] 写入队列失败:", e.message));
}

async function drainWrites() {
  if (writing) return;
  writing = true;
  try {
    while (writeQueue.length) {
      const task = writeQueue.shift();
      try {
        await flushTurn(task);
      } catch (e) {
        console.warn("[xiaoyu-memory] 单轮写入失败:", e.message);
      }
    }
  } finally {
    writing = false;
  }
}

async function flushTurn({ sid, userText, replyText }) {
  const candidates = extractCandidates({ userText, source: `session:${sid}` });
  for (const entry of candidates) {
    const fp = fingerprint(entry.title);
    const set = loadSeen();
    if (set.has(fp)) continue;

    const written = await writeMemory(entry);
    if (written && written.memory) {
      set.add(fp);
      if (written.conflict) {
        console.log(`[xiaoyu-memory] 待确认冲突：${written.conflict.message}`);
      }
    }
  }
  void replyText;
}

// 写记忆：冲突判断 → 入库 → 情绪事件 → 建向量（同一语义空间内）
export async function writeMemory(entry) {
  if (!entry || !entry.title) return null;

  const conflict = checkConflict(entry);
  const status = conflict.conflict ? "conflict" : "active";
  const inserted = insertMemory({
    ...entry,
    status,
    conflict_with: conflict.conflict ? conflict.oldId : null,
    conflict_note: conflict.conflict ? conflict.message : null,
  });

  // 情绪事件落库（即时通道）
  recordEmotion({
    memory_id: inserted.id,
    mood: entry.mood || null,
    valence: entry.valence ?? 0,
    arousal: entry.arousal ?? 0.5,
    source: "live",
  });

  // 向量：只在同一语义空间里追加，避免哈希向量污染真实 embedding 索引
  try {
    const vec = await embed(`${entry.title} ${entry.summary || ""}`);
    const meta = indexMeta();
    const space = vec?.space || meta?.model || "unknown";
    if (!meta?.model) {
      setIndexMeta({ model: space, dim: vec.length, since: Date.now() });
    } else if (meta.model !== space) {
      console.warn(`[xiaoyu-memory] 跳过向量写入：索引空间为 ${meta.model}，本次为 ${space}（请先启动 Ollama 或重建索引）`);
      return { memory: inserted, conflict: conflict.conflict ? conflict : null, vector: "skipped-space-mismatch" };
    }
    upsertVector(inserted.id, vec);
    saveVectors();
  } catch (e) {
    console.warn("[xiaoyu-memory] 向量写入失败:", e.message);
  }

  return { memory: inserted, conflict: conflict.conflict ? conflict : null };
}

function buildConflictContext(conflicts) {
  const lines = conflicts.slice(0, 5).map((m) =>
    `- [${m.id}] ${m.title}${m.summary ? "：" + m.summary : ""}${m.conflict_note ? `（${m.conflict_note}）` : ""}`
  );
  return [
    "【待确认的记忆冲突】下面这些新记忆与旧记忆矛盾，尚未生效。需要时向用户确认以哪个为准；确认后用 xiaoyu_resolve_conflict 保留正确的一条：",
    ...lines,
  ].join("\n");
}

export { recall } from "./engine/recall.js";
export { runConsolidation } from "./engine/consolidation.js";

// Cordis 插件标准形态：命名导出 + 默认对象兼容两种加载方式。
export default { name, inject, apply };
