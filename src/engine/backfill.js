// backfill：解压 zstd 会话，抽取有长期记忆价值的内容回填进新库。
// 幂等：按消息 id 写 meta 游标，重复跑不会重复入库。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getConfig } from "../config.js";
import { insertMemory, setMeta, getMeta } from "../store/meta-db.js";
import { upsertVector, save as saveVectors } from "../store/vector-index.js";
import { embed } from "../store/embedding.js";
import { classify, isWorthRemembering, makeTitle, fingerprint } from "./extract.js";
import { inferEmotion, recordEmotion } from "./emotion.js";

const BACKFILL_KEY = "backfill_cursor";

function walkZstd(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkZstd(p, out);
    else if (e.isFile() && e.name.endsWith(".zstd")) out.push(p);
  }
  return out;
}

function extractTextFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// 从一条 jsonl 行抽取文本
function parseLine(line) {
  try {
    const obj = JSON.parse(line);
    if (obj.type === "user/message" && obj.data?.source?.kind === "user") {
      return { role: "user", text: extractTextFromContent(obj.data?.content), time: obj.time, id: obj.data?.id };
    }
    if (obj.type === "assistant/message") {
      const content = obj.data?.message?.content || [];
      const text = extractTextFromContent(content);
      return { role: "assistant", text, time: obj.time, id: obj.data?.message?.id };
    }
  } catch { /* 跳过坏行 */ }
  return null;
}

function extractFromSessionFile(filePath) {
  const lines = execSync(`zstd -dc "${filePath}"`, { maxBuffer: 50 * 1024 * 1024 }).toString().split("\n");
  const candidates = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed || !isWorthRemembering(parsed.text)) continue;
    candidates.push(parsed);
  }
  return candidates;
}

export async function backfillSessions({ dryRun = true, limit = 20, sourceFilter = null } = {}) {
  const sessionsRoot = join(homedir(), ".dsh", "sessions");
  const files = walkZstd(sessionsRoot);

  let scanned = 0, added = 0, skipped = 0;
  const preview = [];

  for (const f of files) {
    if (scanned >= limit) break;
    if (sourceFilter && !f.includes(sourceFilter)) continue;
    scanned++;
    try {
      const candidates = extractFromSessionFile(f);
      for (const c of candidates) {
        const title = makeTitle(c.text);
        const key = `bf_${c.id || fingerprint(title)}`;
        if (getMeta(key)) { skipped++; continue; }

        const cls = classify(c.text);
        const emotion = inferEmotion(c.text);
        const entry = {
          title,
          summary: c.text.slice(0, 200),
          type: c.role === "user" ? cls.type : "note",
          tags: c.role === "user" ? cls.tags : ["note"],
          canonical_key: cls.canonical_key,
          salience: c.role === "user" ? cls.salience : 0.4,
          source: `session:${basename(f)}`,
          provenance: `backfill-${c.role}`,
          half_life_days: 30,
          mood: emotion.mood,
          valence: emotion.valence,
          arousal: emotion.arousal,
        };

        if (dryRun) {
          preview.push({ role: c.role, title, time: new Date(c.time || Date.now()).toISOString() });
        } else {
          const inserted = insertMemory(entry);
          recordEmotion({ memory_id: inserted.id, ...emotion, source: `backfill-${c.role}` });
          const vec = await embed(`${title} ${entry.summary}`);
          upsertVector(inserted.id, vec);
          setMeta(key, inserted.id);
          added++;
        }
      }
    } catch (e) {
      console.warn(`  跳过 ${f}: ${e.message}`);
    }
  }

  if (!dryRun) saveVectors();
  setMeta(BACKFILL_KEY, String(scanned));
  return { scanned, added, skipped, dryRun, preview: preview.slice(0, 20) };
}

export async function runBackfill(opts = {}) {
  const cfg = getConfig();
  const options = { dryRun: cfg.backfill.dryRun, limit: cfg.backfill.batchSize * 4, ...opts };
  console.log("[backfill] 开始历史会话回填...");
  const result = await backfillSessions(options);
  console.log(`[backfill] 扫描 ${result.scanned} 个会话, 写入 ${result.added} 条, 跳过 ${result.skipped} 条`);
  if (result.dryRun) {
    console.log("[backfill] dry-run 预览（前 20 条）:");
    for (const p of result.preview) console.log(`  [${p.role}] ${p.time} ${p.title}`);
  }
  return result;
}

// 命令行入口：node backfill.js [--write] [--limit=N]
// 默认 dry-run；加 --write 才真实写入。
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const opts = { dryRun: !write };
  if (limitArg) opts.limit = Number(limitArg.split("=")[1]) || undefined;
  await runBackfill(opts);
}
