// meta-db：基于 node:sqlite (DatabaseSync) 的元数据存储。
// 不引入 better-sqlite3，零原生依赖。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig } from "../config.js";

let db = null;

function dbPath() {
  const cfg = getConfig();
  const p = join(cfg.vectorRoot, "meta.sqlite");
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

export function openDb() {
  if (db) return db;
  const path = dbPath();
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      space TEXT NOT NULL DEFAULT 'owner',
      persona TEXT NOT NULL DEFAULT 'default',
      subject TEXT NOT NULL DEFAULT 'owner',
      type TEXT NOT NULL DEFAULT 'fact',
      title TEXT NOT NULL,
      summary TEXT,
      content_ref TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      entities TEXT NOT NULL DEFAULT '[]',
      canonical_key TEXT,
      valence REAL,
      arousal REAL,
      mood TEXT,
      salience REAL NOT NULL DEFAULT 0.5,
      emotional_weight REAL NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      conflict_with TEXT,
      conflict_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_access INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      half_life_days INTEGER,
      layers TEXT NOT NULL DEFAULT 'gist',
      embedding_ref TEXT,
      provenance TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS idx_memories_canonical ON memories(canonical_key);
    CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

    CREATE TABLE IF NOT EXISTS emotion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT,
      mood TEXT,
      valence REAL,
      arousal REAL,
      ts INTEGER NOT NULL,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_emotion_ts ON emotion_events(ts);

    CREATE TABLE IF NOT EXISTS links (
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (src_id, dst_id, rel)
    );
    CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_id);
    CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_id);

    CREATE TABLE IF NOT EXISTS triggers (
      word TEXT PRIMARY KEY,
      grp TEXT,
      linked_tags TEXT NOT NULL DEFAULT '[]',
      linked_memory_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function now() {
  return Date.now();
}

function newId() {
  return "mem_" + now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

export function insertMemory(m) {
  const d = openDb();
  const id = m.id || newId();
  const ts = now();
  const stmt = d.prepare(`
    INSERT INTO memories (
      id, space, persona, subject, type, title, summary, content_ref, tags, entities,
      canonical_key, valence, arousal, mood, salience, emotional_weight, pinned, source,
      status, conflict_with, conflict_note, created_at, updated_at, last_access,
      access_count, half_life_days, layers, embedding_ref, provenance
    ) VALUES (
      @id, @space, @persona, @subject, @type, @title, @summary, @content_ref, @tags, @entities,
      @canonical_key, @valence, @arousal, @mood, @salience, @emotional_weight, @pinned, @source,
      @status, @conflict_with, @conflict_note, @created_at, @updated_at, @last_access,
      @access_count, @half_life_days, @layers, @embedding_ref, @provenance
    )
  `);
  const row = {
    id,
    space: m.space || "owner",
    persona: m.persona || "default",
    subject: m.subject || "owner",
    type: m.type || "fact",
    title: m.title || "",
    summary: m.summary || null,
    content_ref: m.content_ref || null,
    tags: JSON.stringify(m.tags || []),
    entities: JSON.stringify(m.entities || []),
    canonical_key: m.canonical_key || null,
    valence: m.valence ?? null,
    arousal: m.arousal ?? null,
    mood: m.mood || null,
    salience: m.salience ?? 0.5,
    emotional_weight: m.emotional_weight ?? 0,
    pinned: m.pinned ? 1 : 0,
    source: m.source || null,
    status: m.status || "active",
    conflict_with: m.conflict_with || null,
    conflict_note: m.conflict_note || null,
    created_at: ts,
    updated_at: ts,
    last_access: ts,
    access_count: 0,
    half_life_days: m.half_life_days || null,
    layers: m.layers || "gist",
    embedding_ref: m.embedding_ref || null,
    provenance: m.provenance || null,
  };
  stmt.run(row);
  return getMemory(id);
}

export function getMemory(id) {
  const d = openDb();
  const row = d.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  return row ? hydrate(row) : null;
}

export function updateMemory(id, patch) {
  const d = openDb();
  const fields = [];
  const params = { id, updated_at: now() };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    let val = v;
    if (k === "tags" || k === "entities") val = JSON.stringify(v || []);
    if (k === "pinned") val = v ? 1 : 0;
    fields.push(`${k} = @${k}`);
    params[k] = val;
  }
  fields.push("updated_at = @updated_at");
  d.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = @id`).run(params);
  return getMemory(id);
}

export function touchMemory(id) {
  const d = openDb();
  d.prepare("UPDATE memories SET last_access = ?, access_count = access_count + 1 WHERE id = ?").run(now(), id);
}

export function listMemories(filter = {}) {
  const d = openDb();
  const where = [];
  const params = {};
  if (filter.status) { where.push("status = @status"); params.status = filter.status; }
  if (filter.space) { where.push("space = @space"); params.space = filter.space; }
  if (filter.persona) { where.push("persona = @persona"); params.persona = filter.persona; }
  if (filter.canonical_key) { where.push("canonical_key = @canonical_key"); params.canonical_key = filter.canonical_key; }
  const sql = `SELECT * FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
  const rows = d.prepare(sql).all(params);
  return rows.map(hydrate);
}

export function findByCanonicalKey(key, excludeId) {
  const d = openDb();
  const rows = d.prepare("SELECT * FROM memories WHERE canonical_key = ?").all(key);
  return rows.map(hydrate).filter((r) => r.id !== excludeId);
}

// ---------- emotion ----------
export function insertEmotionEvent(e) {
  const d = openDb();
  d.prepare(`
    INSERT INTO emotion_events (memory_id, mood, valence, arousal, ts, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(e.memory_id || null, e.mood || null, e.valence ?? null, e.arousal ?? null, e.ts || now(), e.source || null);
}

export function emotionEventsSince(sinceTs) {
  const d = openDb();
  return d.prepare("SELECT * FROM emotion_events WHERE ts >= ? ORDER BY ts ASC").all(sinceTs);
}

export function emotionEventMemoryIds() {
  const d = openDb();
  return new Set(d.prepare("SELECT DISTINCT memory_id FROM emotion_events WHERE memory_id IS NOT NULL").all().map((r) => r.memory_id));
}

// ---------- links ----------
export function upsertLink(srcId, dstId, rel, weight = 1.0) {
  const d = openDb();
  d.prepare(`
    INSERT INTO links (src_id, dst_id, rel, weight) VALUES (?, ?, ?, ?)
    ON CONFLICT(src_id, dst_id, rel) DO UPDATE SET weight = excluded.weight
  `).run(srcId, dstId, rel, weight);
}

export function linksOf(memoryId) {
  const d = openDb();
  return d.prepare("SELECT * FROM links WHERE src_id = ? OR dst_id = ?").all(memoryId, memoryId);
}

// 全量边（无向表里每条边只存一行，导出时必须走这里，避免按节点遍历导致重复计数）
export function allLinks() {
  const d = openDb();
  return d.prepare("SELECT src_id, dst_id, rel, weight FROM links").all();
}

// ---------- triggers ----------
export function upsertTrigger(word, grp, linkedTags = [], linkedMemoryIds = []) {
  const d = openDb();
  d.prepare(`
    INSERT INTO triggers (word, grp, linked_tags, linked_memory_ids) VALUES (?, ?, ?, ?)
    ON CONFLICT(word) DO UPDATE SET grp = excluded.grp, linked_tags = excluded.linked_tags, linked_memory_ids = excluded.linked_memory_ids
  `).run(word, grp, JSON.stringify(linkedTags), JSON.stringify(linkedMemoryIds));
}

export function allTriggers() {
  const d = openDb();
  return d.prepare("SELECT * FROM triggers").all().map((r) => ({
    ...r,
    linked_tags: JSON.parse(r.linked_tags || "[]"),
    linked_memory_ids: JSON.parse(r.linked_memory_ids || "[]"),
  }));
}

// ---------- meta kv ----------
export function getMeta(key) {
  const d = openDb();
  const row = d.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  const d = openDb();
  d.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function hydrate(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    entities: JSON.parse(row.entities || "[]"),
    pinned: !!row.pinned,
  };
}
