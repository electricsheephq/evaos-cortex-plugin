/**
 * cortex — OpenClaw plugin bridging to Cortex HTTP API.
 *
 * Design principles:
 *   - HTTP-only: pure fetch() to Cortex, no Python subprocesses
 *   - Lazy injection: only inject memories when query seems memory-relevant
 *   - Non-blocking capture: agent_end fires and forgets, never blocks gateway
 *   - Token budget: hard cap on injected content (default 2000 tokens ~8000 chars)
 *   - Graceful degradation: Cortex down → log warning, continue
 *   - Session wake/sleep: non-blocking lifecycle calls
 *   - Lane guards: skip injection/capture for heartbeat, boot, subagent, cron lanes
 *   - Junk filter: drop trivial/noisy messages before capture
 *
 * Hooks:
 *   before_agent_start → POST /api/v1/memories/retrieve  → prependContext
 *   agent_end          → POST /api/v1/memories/remember   → fire-and-forget
 *   session_start      → POST /api/v1/sessions/wake
 *   session_end        → POST /api/v1/sessions/sleep
 *
 * Tools: cortex_search, cortex_remember, cortex_forget, cortex_ask,
 *        cortex_list_contradictions, cortex_resolve_contradiction,
 *        cortex_add_commitment, cortex_update_commitment, cortex_list_commitments,
 *        cortex_add_open_loop, cortex_resolve_open_loop, cortex_list_open_loops
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Dynamic require for node:sqlite (available in Node 22+, avoids TS import issues)
let NodeDatabaseSync: any;
try {
  NodeDatabaseSync = require("node:sqlite").DatabaseSync;
} catch {
  // node:sqlite not available — cache will be disabled
}

// --- Types ---

interface EvaMemoryConfig {
  cortexUrl: string;
  apiKey: string;
  ownerId: string;
  autoRecall: boolean;
  autoCapture: boolean;
  shadowMode: boolean;
  retrievalBudget: number;
  maxInjectionChars: number;
  maxInjectedMemories: number;
  minRelevanceScore: number;
  retrievalMode: string; // auto | fast | thorough
  recencyFilterMinutes: number; // filter out memories created within this window (echo suppression)
  injectCornerstones: boolean; // whether to fetch+inject cornerstones (false if already in SOUL.md)
  injectionFormat: "v1" | "v2";
  showConflicts: boolean;
  showRelations: boolean;
  dedup: boolean;
  // Injection screening (R-417 / R-418)
  enableInjectionScreening: boolean; // default true
  injectionHardFloor: number; // default 0.50 — hard drop below this regardless of mode
  injectionCriticalThreshold: number; // default 0.75
  injectionTechnicalThreshold: number; // default 0.60
  injectionPersonalThreshold: number; // default 0.45
}

interface RetrievedItem {
  source: string;
  item_id: string;
  content: string;
  score: number;
  source_session_id?: string;
  created_at?: string;
  item_type?: string;
  metadata?: {
    memory_class?: string;
    salience?: string;
    status?: string;
    category?: string;
    explicitness?: string;
    stability?: string;
    is_deleted?: number;
  };
  provenance?: string;
}

interface RetrievalResult {
  context_block: string; // pre-formatted context string from Cortex
  items: RetrievedItem[];
  tokens_used: number;
  mode: string;
}

type CompanyBrainQueryIntent =
  | "auto"
  | "account_brief"
  | "daily_brief"
  | "what_changed"
  | "follow_ups"
  | "blocked"
  | "open_loops";

type CompanyBrainToolResult = Record<string, unknown>;

interface ProcessedItem {
  item: RetrievedItem;
  duplicateCount: number;
  conflictWithId?: string;
  relationHint?: string;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function addOptionalParam(params: URLSearchParams, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) params.set(key, value.trim());
  if (typeof value === "number" && Number.isFinite(value)) params.set(key, String(Math.trunc(value)));
}

function addOwnerParam(params: URLSearchParams, ownerId: string): void {
  // The Cortex API remains authoritative for ownership. Tenant/JWT callers cannot
  // override auth owner; this explicit owner is for self-host and owner-bound API keys.
  if (ownerId && ownerId !== "default") params.set("owner_id", ownerId);
}

export function formatCompanyBrainToolResult(label: string, result: CompanyBrainToolResult | null): string {
  if (!result) {
    return `${label} failed: Cortex returned no result.`;
  }
  return `${label}:\n${JSON.stringify(result, null, 2)}`;
}

// --- Config ---

function resolveEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? "");
}

function parseConfig(raw: unknown): EvaMemoryConfig {
  const defaults: EvaMemoryConfig = {
    cortexUrl: "http://localhost:8000",
    apiKey: "",
    ownerId: "default",
    autoRecall: true,
    autoCapture: true,
    shadowMode: false,
    retrievalBudget: 2000,
    maxInjectionChars: 8000,
    maxInjectedMemories: 8,
    minRelevanceScore: 0.25,
    retrievalMode: "fast",
    recencyFilterMinutes: 15,
    injectCornerstones: false,
    injectionFormat: "v1",
    showConflicts: true,
    showRelations: true,
    dedup: true,
    enableInjectionScreening: true,
    injectionHardFloor: 0.50,
    injectionCriticalThreshold: 0.75,
    injectionTechnicalThreshold: 0.60,
    injectionPersonalThreshold: 0.45,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const c = raw as Record<string, unknown>;
  const VALID_MODES = ["auto", "fast", "thorough"];
  const parsedMode = typeof c.retrievalMode === "string" && VALID_MODES.includes(c.retrievalMode)
    ? c.retrievalMode
    : defaults.retrievalMode;
  const parsedInjectionFormat = c.injectionFormat === "v2" ? "v2" : defaults.injectionFormat;
  return {
    cortexUrl: typeof c.cortexUrl === "string" ? resolveEnv(c.cortexUrl) : defaults.cortexUrl,
    apiKey: typeof c.apiKey === "string" ? resolveEnv(c.apiKey) : defaults.apiKey,
    ownerId: typeof c.ownerId === "string" && c.ownerId ? c.ownerId : defaults.ownerId,
    autoRecall: c.autoRecall !== false,
    autoCapture: c.autoCapture !== false,
    shadowMode: c.shadowMode === true,
    retrievalBudget: typeof c.retrievalBudget === "number" ? c.retrievalBudget : defaults.retrievalBudget,
    maxInjectionChars: typeof c.maxInjectionChars === "number" ? c.maxInjectionChars : defaults.maxInjectionChars,
    maxInjectedMemories: typeof c.maxInjectedMemories === "number" ? c.maxInjectedMemories : defaults.maxInjectedMemories,
    minRelevanceScore: typeof c.minRelevanceScore === "number" ? c.minRelevanceScore : defaults.minRelevanceScore,
    retrievalMode: parsedMode,
    recencyFilterMinutes: typeof c.recencyFilterMinutes === "number" ? c.recencyFilterMinutes : defaults.recencyFilterMinutes,
    injectCornerstones: c.injectCornerstones === true, // default false — cornerstones loaded from SOUL.md
    injectionFormat: parsedInjectionFormat,
    showConflicts: c.showConflicts !== false,
    showRelations: c.showRelations !== false,
    dedup: c.dedup !== false,
    enableInjectionScreening: c.enableInjectionScreening !== false,
    injectionHardFloor: typeof c.injectionHardFloor === "number" ? c.injectionHardFloor : defaults.injectionHardFloor,
    injectionCriticalThreshold: typeof c.injectionCriticalThreshold === "number" ? c.injectionCriticalThreshold : defaults.injectionCriticalThreshold,
    injectionTechnicalThreshold: typeof c.injectionTechnicalThreshold === "number" ? c.injectionTechnicalThreshold : defaults.injectionTechnicalThreshold,
    injectionPersonalThreshold: typeof c.injectionPersonalThreshold === "number" ? c.injectionPersonalThreshold : defaults.injectionPersonalThreshold,
  };
}

// --- HTTP Client ---

class CortexClient {
  private warn: (msg: string) => void;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private ownerId: string,
    warnFn?: (msg: string) => void,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.warn = warnFn ?? console.warn;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    // NOTE: X-Owner-Id intentionally NOT sent — server resolves ownership
    // from the API key via flyio-sync. Sending owner_id in headers would
    // allow identity spoofing in legacy auth mode.
    return h;
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 5000): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.headers.get("Deprecation") === "true") {
        const sunset = res.headers.get("Sunset") ?? "unknown";
        const link = res.headers.get("Link") ?? "";
        this.warn(
          `[cortex] WARNING: ${path} is deprecated (Sunset: ${sunset}).${link ? ` ${link}` : ""}`,
        );
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  private async get<T>(path: string, timeoutMs = 5000): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  private async patch<T>(path: string, body: unknown, timeoutMs = 5000): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  private async del<T>(path: string, timeoutMs = 5000): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "DELETE",
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  // --- Memory ---

  async retrieve(query: string, tokenBudget: number, mode = "auto"): Promise<RetrievalResult | null> {
    // 2000ms timeout: allows for cold-start and first-embed latency.
    // For self-hosted Cortex (localhost or LAN) 200-800ms is typical.
    return this.post<RetrievalResult>("/api/v1/memories/retrieve", {
      query,
      token_budget: tokenBudget,
      mode,
      owner_id: this.ownerId,
    }, 2000);
  }

  remember(conversation: Array<{ role: string; content: string }>, sessionId?: string, shadow = false): Promise<unknown> {
    const path = shadow ? "/api/v1/memories/remember?shadow=true" : "/api/v1/memories/remember";
    return this.post(path, { conversation, session_id: sessionId, source_session_id: sessionId, owner_id: this.ownerId }, 30000);
  }

  async search(query: string, limit = 10) {
    // API v1.2.0: field is "top_k" not "limit" (http-complete.md §POST /api/v1/memories/search)
    return this.post<{ items: Record<string, unknown>[]; total: number }>(
      "/api/v1/memories/search",
      { query, owner_id: this.ownerId, top_k: limit },
    );
  }

  async forget(memoryId: string) {
    return this.del<{ memory_id: string; deleted: boolean }>(
      `/api/v1/memories/${encodeURIComponent(memoryId)}?owner_id=${encodeURIComponent(this.ownerId)}`,
    );
  }

  // --- Sessions ---

  wake(sessionId: string): void {
    // API v1.3.0 canonical: /api/v1/sessions/wake
    this.post("/api/v1/sessions/wake", { session_id: sessionId }).catch(() => {});
  }

  sleep(sessionId: string): void {
    // API v1.3.0 canonical: /api/v1/sessions/sleep
    this.post("/api/v1/sessions/sleep", { session_id: sessionId }).catch(() => {});
  }

  // --- Dialectic ---

  async ask(question: string, ownerId?: string, limit = 5) {
    return this.post<{ answer: string; sources: Record<string, unknown>[]; confidence: number; ok: boolean; errors: string[] }>(
      "/api/v1/ask",
      { query: question, owner_id: ownerId ?? this.ownerId, max_steps: limit },
    );
  }

  // --- Contradictions ---

  async listContradictions(ownerId?: string) {
    const params = new URLSearchParams({ owner_id: ownerId ?? this.ownerId });
    return this.get<{ items: Record<string, unknown>[]; total: number; errors: string[] }>(
      `/api/v1/contradictions?${params}`,
    );
  }

  async resolveContradiction(id: string, resolution: string, ownerId?: string) {
    return this.patch<Record<string, unknown>>(
      `/api/v1/contradictions/${encodeURIComponent(id)}`,
      { resolution, owner_id: ownerId ?? this.ownerId },
    );
  }

  // --- Commitments ---

  async addCommitment(description: string, dueAt?: string, ownerId?: string) {
    return this.post<Record<string, unknown>>(
      "/api/v1/commitments",
      { content: description, due_at: dueAt, owner_id: ownerId ?? this.ownerId },
    );
  }

  async updateCommitment(commitmentId: string, commitmentStatus: string, ownerId?: string) {
    return this.patch<Record<string, unknown>>(
      `/api/v1/commitments/${encodeURIComponent(commitmentId)}`,
      { status: commitmentStatus, owner_id: ownerId ?? this.ownerId },
    );
  }

  async listCommitments(ownerId?: string, status?: string) {
    const params = new URLSearchParams({ owner_id: ownerId ?? this.ownerId });
    if (status) params.set("status", status);
    return this.get<{ commitments?: Record<string, unknown>[]; total?: number }>(`/api/v1/commitments?${params}`);
  }

  // --- Insights ---

  async listInsights(status = "pending", limit = 5) {
    return this.get<{ insights?: Record<string, unknown>[]; count?: number }>(
      `/api/v1/insights?owner_id=${encodeURIComponent(this.ownerId)}&status=${encodeURIComponent(status)}&limit=${encodeURIComponent(String(limit))}`,
    );
  }

  // --- Open Loops ---

  async addOpenLoop(description: string, ownerId?: string) {
    return this.post<Record<string, unknown>>(
      "/api/v1/open-loops",
      { content: description, owner_id: ownerId ?? this.ownerId },
    );
  }

  async resolveOpenLoop(loopId: string, ownerId?: string) {
    return this.patch<Record<string, unknown>>(
      `/api/v1/open-loops/${encodeURIComponent(loopId)}`,
      { owner_id: ownerId ?? this.ownerId },
    );
  }

  async listOpenLoops(ownerId?: string, status?: string) {
    const params = new URLSearchParams({ owner_id: ownerId ?? this.ownerId });
    if (status) params.set("status", status);
    return this.get<{ open_loops?: Record<string, unknown>[]; total?: number }>(`/api/v1/open-loops?${params}`);
  }

  // --- Company Brain ---

  async listCompanyBrainAccounts(options: {
    search?: string;
    workspaceId?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const params = new URLSearchParams();
    addOwnerParam(params, this.ownerId);
    addOptionalParam(params, "search", options.search);
    addOptionalParam(params, "workspace_id", options.workspaceId);
    params.set("limit", String(clampNumber(options.limit, 50, 1, 200)));
    params.set("offset", String(clampNumber(options.offset, 0, 0, 1000000)));
    const query = params.toString();
    return this.get<CompanyBrainToolResult>(`/api/v1/company-brain/accounts${query ? `?${query}` : ""}`);
  }

  async getCompanyBrainAccountBrief(accountId: string, options: { factsLimit?: number; factsOffset?: number } = {}) {
    const params = new URLSearchParams();
    addOwnerParam(params, this.ownerId);
    params.set("facts_limit", String(clampNumber(options.factsLimit, 50, 1, 200)));
    params.set("facts_offset", String(clampNumber(options.factsOffset, 0, 0, 1000000)));
    return this.get<CompanyBrainToolResult>(
      `/api/v1/company-brain/accounts/${encodeURIComponent(accountId)}/brief?${params}`,
    );
  }

  async getCompanyBrainAccountTimeline(accountId: string, options: { limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams();
    addOwnerParam(params, this.ownerId);
    params.set("limit", String(clampNumber(options.limit, 50, 1, 200)));
    params.set("offset", String(clampNumber(options.offset, 0, 0, 1000000)));
    return this.get<CompanyBrainToolResult>(
      `/api/v1/company-brain/accounts/${encodeURIComponent(accountId)}/timeline?${params}`,
    );
  }

  async queryCompanyBrain(options: {
    accountId: string;
    intent?: CompanyBrainQueryIntent;
    question?: string;
    limit?: number;
  }) {
    return this.post<CompanyBrainToolResult>(
      "/api/v1/company-brain/query",
      {
        owner_id: this.ownerId && this.ownerId !== "default" ? this.ownerId : undefined,
        account_id: options.accountId,
        intent: options.intent ?? "auto",
        question: options.question,
        limit: clampNumber(options.limit, 10, 1, 50),
      },
    );
  }

  // --- Cornerstones ---

  async getCornerstones(): Promise<Array<{ label: string; content: string }> | null> {
    const params = new URLSearchParams({ owner_id: this.ownerId });
    return this.get<Array<{ label: string; content: string }>>(
      `/api/v1/cornerstones?${params}`,
      3000,
    );
  }

  // --- Health ---

  async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/health`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  // --- Bulk list (for cache sync) ---

  async listMemories(perPage = 200, page = 1, includeEmbeddings = false): Promise<{ items: any[]; total: number; pages: number } | null> {
    const params = new URLSearchParams({
      owner_id: this.ownerId,
      per_page: String(perPage),
      page: String(page),
      status: "active",
    });
    if (includeEmbeddings) params.set("include_embeddings", "true");
    return this.get<{ items: any[]; total: number; pages: number }>(
      `/api/v1/memories?${params}`,
      15000, // longer timeout for bulk fetch
    );
  }
}

// --- Local SQLite Memory Cache ---

class LocalMemoryCache {
  private db: any; // DatabaseSync from node:sqlite

  constructor(dbPath: string) {
    // Ensure parent directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new NodeDatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cached_memories (
        item_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_session_id TEXT,
        created_at TEXT,
        salience TEXT,
        category TEXT,
        status TEXT DEFAULT 'active',
        is_deleted INTEGER DEFAULT 0,
        score REAL DEFAULT 0,
        item_type TEXT,
        updated_at TEXT,
        synced_at TEXT,
        embedding BLOB,
        embedding_model TEXT
      )
    `);
    // Migration: add embedding columns if missing (existing DBs)
    try {
      this.db.exec("ALTER TABLE cached_memories ADD COLUMN embedding BLOB");
    } catch { /* column already exists */ }
    try {
      this.db.exec("ALTER TABLE cached_memories ADD COLUMN embedding_model TEXT");
    } catch { /* column already exists */ }
    // FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS cached_memories_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='porter unicode61'
      )
    `);
    // Metadata key-value store
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
  }

  upsert(item: RetrievedItem & { embedding?: string | null; embedding_model?: string | null }): void {
    const now = new Date().toISOString();
    // Decode base64 embedding to Buffer if present
    const embBuf = item.embedding ? Buffer.from(item.embedding, "base64") : null;
    const embModel = item.embedding_model ?? null;
    // Upsert main table (use prepared statement for BLOB binding)
    const stmt = this.db.prepare(`
      INSERT INTO cached_memories (item_id, content, source_session_id, created_at, salience, category, status, is_deleted, score, item_type, updated_at, synced_at, embedding, embedding_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        content=excluded.content, source_session_id=excluded.source_session_id,
        created_at=excluded.created_at, salience=excluded.salience, category=excluded.category,
        status=excluded.status, is_deleted=0, score=excluded.score, item_type=excluded.item_type,
        updated_at=excluded.updated_at, synced_at=excluded.synced_at,
        embedding=excluded.embedding, embedding_model=excluded.embedding_model
    `);
    stmt.run(
      item.item_id,
      item.content,
      item.source_session_id ?? "",
      item.created_at ?? "",
      item.metadata?.salience ?? "",
      item.metadata?.category ?? "",
      item.metadata?.status ?? "active",
      Number.isFinite(item.score) ? item.score : 0,
      item.item_type ?? "",
      now,
      now,
      embBuf,
      embModel,
    );
    // Sync FTS — delete old entry if exists, then insert (prepared statements to avoid SQL injection)
    const rowid = this.db.prepare("SELECT rowid FROM cached_memories WHERE item_id = ?").get(item.item_id) as any;
    if (rowid) {
      this.db.prepare("DELETE FROM cached_memories_fts WHERE rowid = ?").run(rowid.rowid);
      this.db.prepare("INSERT INTO cached_memories_fts (rowid, content) VALUES (?, ?)").run(rowid.rowid, item.content);
    }
  }

  upsertBatch(items: RetrievedItem[]): void {
    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const item of items) {
        this.upsert(item);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  search(query: string, limit: number): RetrievedItem[] {
    if (!query || !query.trim()) return [];
    // Sanitize query for FTS5: remove special chars, split into terms, join with spaces
    // Use OR between terms so multi-word queries aren't too restrictive
    const sanitized = query.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean).join(" OR ");
    if (!sanitized) return [];
    try {
      const rows = this.db.prepare(`
        SELECT m.item_id, m.content, m.source_session_id, m.created_at, m.salience,
               m.category, m.status, m.score, m.item_type,
               rank
        FROM cached_memories_fts f
        JOIN cached_memories m ON f.rowid = m.rowid
        WHERE cached_memories_fts MATCH ? AND m.is_deleted = 0
        ORDER BY rank
        LIMIT ?
      `).all(sanitized, limit) as any[];
      return rows.map((r: any) => ({
        source: "local_cache",
        item_id: r.item_id,
        content: r.content,
        score: r.rank ?? 0,  // FTS5 BM25 rank (negative, lower = better match)
        source_session_id: r.source_session_id || undefined,
        created_at: r.created_at || undefined,
        item_type: r.item_type || undefined,
        metadata: {
          salience: r.salience || undefined,
          category: r.category || undefined,
          status: r.status || undefined,
        },
      }));
    } catch {
      // FTS5 query syntax error or empty table
      return [];
    }
  }

  markDeleted(itemId: string): void {
    this.db.prepare("UPDATE cached_memories SET is_deleted = 1, updated_at = ? WHERE item_id = ?").run(new Date().toISOString(), itemId);
  }

  getLastSync(): string | null {
    const row = this.db.prepare("SELECT value FROM cache_meta WHERE key = 'last_sync'").get() as any;
    return row?.value ?? null;
  }

  setLastSync(ts: string): void {
    this.db.prepare("INSERT INTO cache_meta (key, value) VALUES ('last_sync', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(ts);
  }

  getCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM cached_memories WHERE is_deleted = 0").get() as any;
    return row?.cnt ?? 0;
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /**
   * Brute-force cosine similarity search against locally cached embeddings.
   * At ~850 items (3.4MB), this runs in <1ms.
   */
  cosineSearch(queryEmbedding: Float32Array, limit: number): RetrievedItem[] {
    const rows = this.db.prepare(`
      SELECT item_id, content, source_session_id, created_at, salience,
             category, status, score, item_type, embedding
      FROM cached_memories
      WHERE is_deleted = 0 AND embedding IS NOT NULL
    `).all() as any[];

    const scored: { row: any; sim: number }[] = [];
    const qLen = Math.sqrt(queryEmbedding.reduce((s, v) => s + v * v, 0));
    if (qLen === 0) return [];

    for (const row of rows) {
      const blob = row.embedding as Uint8Array | null;
      if (!blob || blob.byteLength < 4) continue;
      // Defensive copy: ensure 4-byte alignment for Float32Array (SQLite BLOB buffer may not be aligned)
      let docEmb: Float32Array;
      if (blob.byteOffset % 4 === 0) {
        docEmb = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      } else {
        const aligned = new Uint8Array(blob.byteLength);
        aligned.set(blob);
        docEmb = new Float32Array(aligned.buffer, 0, blob.byteLength / 4);
      }
      if (docEmb.length !== queryEmbedding.length) continue;

      let dot = 0, dLen = 0;
      for (let i = 0; i < docEmb.length; i++) {
        dot += queryEmbedding[i] * docEmb[i];
        dLen += docEmb[i] * docEmb[i];
      }
      dLen = Math.sqrt(dLen);
      if (dLen === 0) continue;
      const sim = dot / (qLen * dLen);
      scored.push({ row, sim });
    }

    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit).map(({ row, sim }) => ({
      source: "local_cache_cosine",
      item_id: row.item_id,
      content: row.content,
      score: sim,
      source_session_id: row.source_session_id || undefined,
      created_at: row.created_at || undefined,
      item_type: row.item_type || undefined,
      metadata: {
        salience: row.salience || undefined,
        category: row.category || undefined,
        status: row.status || undefined,
      },
    }));
  }

  /**
   * Hybrid search: merge FTS5 BM25 results with cosine similarity results.
   * α=0.3 for BM25, (1-α)=0.7 for cosine.
   */
  hybridSearch(query: string, queryEmbedding: Float32Array | null, limit: number): RetrievedItem[] {
    const ALPHA = 0.3; // BM25 weight
    const SINGLE_SOURCE_PENALTY = 0.8;

    // Get FTS5 results
    const ftsResults = this.search(query, limit * 2);

    // If no embedding, fall back to FTS-only
    if (!queryEmbedding) return ftsResults.slice(0, limit);

    // Get cosine results
    const cosineResults = this.cosineSearch(queryEmbedding, limit * 2);

    // Normalize FTS scores (BM25 rank is negative, lower = better)
    // Convert to 0-1 range where 1 is best
    const ftsMap = new Map<string, { item: RetrievedItem; normScore: number }>();
    if (ftsResults.length > 0) {
      // BM25 rank values are negative; more negative = more relevant
      // Normalize to [0, 1] range
      const ftsScores = ftsResults.map(r => r.score);
      const minFts = Math.min(...ftsScores);
      const maxFts = Math.max(...ftsScores);
      const ftsRange = maxFts - minFts || 1;
      for (const r of ftsResults) {
        // For BM25 rank (negative), lower is better, so invert
        const normScore = ftsRange === 0 ? 1.0 : 1.0 - (r.score - minFts) / ftsRange;
        ftsMap.set(r.item_id, { item: r, normScore });
      }
    }

    const cosineMap = new Map<string, { item: RetrievedItem; normScore: number }>();
    for (const r of cosineResults) {
      // Cosine similarity is already 0-1 range
      cosineMap.set(r.item_id, { item: r, normScore: r.score });
    }

    // Merge
    const allIds = new Set([...ftsMap.keys(), ...cosineMap.keys()]);
    const merged: { item: RetrievedItem; mergedScore: number }[] = [];

    for (const id of allIds) {
      const ftsEntry = ftsMap.get(id);
      const cosEntry = cosineMap.get(id);

      let mergedScore: number;
      const item = (cosEntry?.item || ftsEntry?.item)!;

      if (ftsEntry && cosEntry) {
        // Both sources — weighted merge
        mergedScore = ALPHA * ftsEntry.normScore + (1 - ALPHA) * cosEntry.normScore;
      } else if (ftsEntry) {
        // FTS only — apply penalty
        mergedScore = ALPHA * ftsEntry.normScore * SINGLE_SOURCE_PENALTY;
      } else {
        // Cosine only — apply penalty
        mergedScore = (1 - ALPHA) * cosEntry!.normScore * SINGLE_SOURCE_PENALTY;
      }

      merged.push({ item: { ...item, score: mergedScore, source: "local_cache_hybrid" }, mergedScore });
    }

    merged.sort((a, b) => b.mergedScore - a.mergedScore);
    return merged.slice(0, limit).map(m => m.item);
  }

  close(): void {
    try { this.checkpoint(); } catch { /* ignore */ }
    try { this.db.close(); } catch { /* ignore */ }
  }
}

/**
 * Embed a query string using Voyage-4-lite API.
 * Returns Float32Array or null on failure (graceful degradation).
 * Cost: ~$0.02/M tokens — negligible.
 */
async function embedQuery(text: string): Promise<Float32Array | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000); // 2s timeout

    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "voyage-4-lite",
        input: [text],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) return null;

    const data = (await resp.json()) as any;
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) return null;

    return new Float32Array(embedding);
  } catch {
    // Timeout, network error, etc. — graceful degradation
    return null;
  }
}

// Background sync: fetch all active memories from server, upsert into local cache
async function syncMemoryCache(
  client: CortexClient,
  cache: LocalMemoryCache,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  try {
    let page = 1;
    let pages = 1;
    let synced = 0;
    let total = 0;
    do {
      const result = await client.listMemories(200, page, true);
      if (!result?.items?.length) break;
      total = result.total ?? 0;
      pages = result.pages ?? 1;
      // Normalize API response shape to RetrievedItem format (with embedding data)
      const normalized = result.items.map((raw: any) => ({
        source: "sync",
        item_id: raw.item_id || raw.id || "",
        content: raw.content || "",
        score: raw.score ?? 0,
        source_session_id: raw.source_session_id || "",
        created_at: raw.created_at || "",
        item_type: raw.item_type || raw.memory_type || "",
        metadata: {
          salience: raw.metadata?.salience || raw.salience || "",
          category: raw.metadata?.category || raw.category || "",
          status: raw.metadata?.status || raw.status || "active",
        },
        embedding: raw.embedding || null,
        embedding_model: raw.embedding_model || null,
      }));
      cache.upsertBatch(normalized);
      synced += result.items.length;
      page++;
    } while (page <= pages);
    cache.setLastSync(new Date().toISOString());
    // Compact WAL to prevent bloat (WAL was 5.7× DB size without this)
    try { cache.checkpoint(); } catch { /* ignore checkpoint errors */ }
    logger.info(`cortex: cache sync complete — ${synced} memories cached (total server: ${total})`);
  } catch (err) {
    logger.warn(`cortex: cache sync failed: ${String(err)}`);
  }
}

// --- Memory-relevance heuristic ---

const MEMORY_KEYWORDS = /\b(remember|forgot|recall|last time|previously|before|earlier|you said|you told|we discussed|we decided|my preference|my name|who am i|what do i|do you know|history|past|memory|memorize|don'?t forget)\b/i;
const TRIVIAL_PATTERNS = /^(hi|hello|hey|thanks|ok|yes|no|sure|bye|good morning|good night|👍|😊)[\s!?.]*$/i;

// Sub-agent completion events and runtime system events should not trigger memory retrieval
const SYSTEM_EVENT_PATTERNS = /\[Internal task completion event\]|<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>|source: subagent|type: subagent task|^\[.*\] Exec (?:completed|failed)|^\[.*\] OpenClaw runtime context/m;

function isMemoryRelevant(prompt: string): boolean {
  if (!prompt || prompt.length < 3) return false;
  if (TRIVIAL_PATTERNS.test(prompt.trim())) return false;
  // Skip sub-agent completion events and runtime system events
  if (SYSTEM_EVENT_PATTERNS.test(prompt)) return false;
  // Short prompts without memory keywords → skip
  if (prompt.length < 40 && !MEMORY_KEYWORDS.test(prompt)) return false;
  // Questions and longer prompts are worth checking
  return true;
}

// --- Lane guards (Kira's additions — prevent injection/capture on system lanes) ---

type HookRunKind = "main" | "subagent" | "cron" | "isolated" | "hook" | "unknown";

type HookLaneContext = {
  runKind?: HookRunKind;
  isHeartbeat?: boolean;
  sessionKey?: string;
};

function resolveHookRunKind(ctx?: HookLaneContext): HookRunKind {
  if (ctx?.runKind) return ctx.runKind;
  const key = ctx?.sessionKey ?? "";
  if (!key) return "unknown";
  if (key.startsWith("hook:")) return "hook";
  if (key.includes(":subagent:")) return "subagent";
  if (key.includes(":cron:")) return "cron";
  if (key.includes(":isolated:")) return "isolated";
  return "main";
}

function isBootPrompt(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return /\bBOOT\.md\b/i.test(prompt) || /\bboot check\b/i.test(prompt) || /\bpost-restart\b/i.test(prompt);
}

function shouldSkipMemoryInjection(prompt: string | undefined, ctx?: HookLaneContext): { skip: boolean; lane: string } {
  const runKind = resolveHookRunKind(ctx);
  if (ctx?.isHeartbeat) return { skip: true, lane: "heartbeat" };
  if (runKind !== "main") return { skip: true, lane: runKind };
  if (isBootPrompt(prompt)) return { skip: true, lane: "boot" };
  return { skip: false, lane: runKind };
}

// --- Conversational junk pre-filter ---
// Messages matching any of these patterns are dropped from the capture payload.
// They represent continuation prompts, retry messages, or engine noise — not
// real conversation worth storing in long-term memory.

const TRIVIAL_CAPTURE_PATTERNS: RegExp[] = [
  /^continue$/i,
  /^continue where you left off/i,
  /^go on$/i,
  /^keep going$/i,
  /^go ahead$/i,
  /^please continue$/i,
  /^the previous model attempt failed/i,
  /^Continue where you left off\. The previous model/i,
  /^\[.*\]\s*continue$/i,        // timestamped "continue" like "[Sun 2026-03-15 20:50 GMT+7] continue"
  /^\[.*\]\s*got it continue/i,  // timestamped "got it continue"
];

// --- Cornerstone Formatting ---

function formatCornerstones(cornerstones: Array<{ label: string; content: string }>): string {
  if (!cornerstones.length) return "";
  const lines = ["[CORNERSTONES — WHO I AM]"];
  for (const cs of cornerstones) {
    lines.push(`${cs.label}: ${cs.content}`);
  }
  return lines.join("\n");
}

// --- Context Formatting ---

/**
 * Filter out echo memories: items from the current session or created too recently.
 * This prevents the recall loop where memories extracted from THIS conversation
 * get injected right back into the next turn.
 */
function filterEchoMemories(
  items: RetrievedItem[],
  currentSessionId: string | undefined,
  recencyFilterMinutes: number,
): RetrievedItem[] {
  if (!currentSessionId && recencyFilterMinutes <= 0) return items;

  const now = Date.now();
  const recencyCutoffMs = recencyFilterMinutes > 0 ? recencyFilterMinutes * 60 * 1000 : 0;

  return items.filter((item) => {
    // Filter 1: exact session match (primary — works for memories with source_session_id)
    if (currentSessionId && item.source_session_id && item.source_session_id === currentSessionId) {
      return false;
    }

    // Filter 2: recency fallback (catches memories without source_session_id, e.g. pre-fix)
    if (recencyCutoffMs > 0 && item.created_at) {
      const createdMs = new Date(item.created_at).getTime();
      if (!isNaN(createdMs) && (now - createdMs) < recencyCutoffMs) {
        return false;
      }
    }

    return true;
  });
}

// --- Injection Screening (R-417 / R-418) ---

/** Session risk mode for dynamic threshold selection. */
type InjectionMode = "critical" | "technical" | "personal";

const TECHNICAL_KEYWORDS = /\b(bench|cortex|debug|config|log|error|exception|script|deploy|git|commit|branch|pytest|migration|run|adapter)\b/i;
const CRITICAL_KEYWORDS = /\b(bench-\d{8}-\d{6}|deploy|cortex error|config operation|migration|fly deploy|openclaw gateway|prod)\b/i;
const RUN_ID_RE = /bench-\d{8}-\d{6}/;
const RUN_ID_RE_GLOBAL = /bench-\d{8}-\d{6}/g;
const GIT_TOKENS = /\b(git|PR #|commit|branch)\b/i;
const FILE_PATH_RE = /[./\\][a-zA-Z0-9_\-./\\]{2,}/;
const LIVENESS_CLAIM = /\b(still active|still running|is running|is active|is alive|currently running)\b/i;
const DEATH_CLAIM = /\b(was killed|is dead|died|crashed|no listener|restarted|dead\b|killed\b|stalled)\b/i;

/** Parse raw plugin config into a validated EvaMemoryConfig object. */
export function parseEvaMemoryConfig(raw: unknown): EvaMemoryConfig {
  return parseConfig(raw);
}

/**
 * Classify the current turn into an injection mode.
 * critical > technical > personal (first match wins).
 */
export function detectInjectionMode(promptText: string): InjectionMode {
  if (CRITICAL_KEYWORDS.test(promptText) || RUN_ID_RE.test(promptText)) return "critical";
  if (
    TECHNICAL_KEYWORDS.test(promptText) ||
    GIT_TOKENS.test(promptText) ||
    FILE_PATH_RE.test(promptText)
  ) return "technical";
  return "personal";
}

/**
 * Two-layer injection screening (R-417 + R-418).
 *
 * Layer 1 — hard rules (deterministic drops)
 *   1.1 Stale run-state: memory claims a bench run is active but current prompt says it’s dead
 *   1.2 Category lane: suppress personal/episodic < 0.70 in technical mode
 *   1.3 Hard floor: drop anything below injectionHardFloor regardless
 *
 * Layer 2 — dynamic confidence threshold per session mode
 *   critical ≥ 0.75, technical ≥ 0.60, personal ≥ 0.45
 *
 * Bonus — contradiction suppression: memory says active, prompt says dead
 */
export function screenInjectionCandidates(
  items: RetrievedItem[],
  promptText: string,
  cfg: Pick<EvaMemoryConfig, "injectionHardFloor" | "injectionCriticalThreshold" | "injectionTechnicalThreshold" | "injectionPersonalThreshold">,
  log?: (msg: string) => void,
): RetrievedItem[] {
  const mode = detectInjectionMode(promptText);
  const hardFloor = Number.isFinite(cfg.injectionHardFloor) ? Math.max(0, Math.min(1, cfg.injectionHardFloor)) : 0.50;
  const criticalThreshold = Number.isFinite(cfg.injectionCriticalThreshold) ? Math.max(0, Math.min(1, cfg.injectionCriticalThreshold)) : 0.75;
  const technicalThreshold = Number.isFinite(cfg.injectionTechnicalThreshold) ? Math.max(0, Math.min(1, cfg.injectionTechnicalThreshold)) : 0.60;
  const personalThreshold = Number.isFinite(cfg.injectionPersonalThreshold) ? Math.max(0, Math.min(1, cfg.injectionPersonalThreshold)) : 0.45;
  const modeThreshold = mode === "critical"
    ? criticalThreshold
    : mode === "technical"
      ? technicalThreshold
      : personalThreshold;

  const promptHasDeathClaim = DEATH_CLAIM.test(promptText);

  // Collect run IDs mentioned in prompt (used for contradiction check)
  const promptRunIds = new Set<string>();
  for (const m of promptText.matchAll(RUN_ID_RE_GLOBAL)) promptRunIds.add(m[0]);

  let dropped = 0;
  const kept: RetrievedItem[] = [];

  for (const item of items) {
    const score = item.score ?? 1.0;
    const content = item.content ?? "";
    const category = (item.metadata?.category ?? "").toLowerCase();

    // --- Layer 1.1: Stale run-state filter ---
    const contentRunIds = [...content.matchAll(RUN_ID_RE_GLOBAL)].map(m => m[0]);
    if (contentRunIds.length > 0 && LIVENESS_CLAIM.test(content) && promptHasDeathClaim) {
      log?.(`[cortex-inject] dropped stale run-state memory: ${content.slice(0, 80)}`);
      dropped++;
      continue;
    }

    // --- Bonus: Contradiction suppression ---
    // Memory claims something is active, but prompt says it’s dead
    if (LIVENESS_CLAIM.test(content) && DEATH_CLAIM.test(promptText)) {
      log?.(`[cortex-inject] dropped contradicted memory (active claim vs dead context): ${content.slice(0, 80)}`);
      dropped++;
      continue;
    }

    // --- Layer 1.3: Hard floor ---
    if (score < hardFloor) {
      dropped++;
      continue;
    }

    // --- Layer 1.2: Category lane filter (technical sessions) ---
    if (mode === "technical" || mode === "critical") {
      const isPersonalCategory = category === "episodic" || category === "personal" || category === "relational" || category === "identity";
      if (isPersonalCategory && score < 0.70) {
        dropped++;
        continue;
      }
    }

    // --- Layer 2: Dynamic confidence threshold ---
    if (score < modeThreshold) {
      dropped++;
      continue;
    }

    kept.push(item);
  }

  log?.(`[cortex-inject] screening dropped ${dropped} memories (hardFloor=${hardFloor}, mode=${mode}, modeThreshold=${modeThreshold})`);
  log?.(`[cortex-inject] injecting ${kept.length}/${items.length} memories after screening`);
  return kept;
}

const MEMORY_PREAMBLE = `Long-term memories from your Cortex memory system, matched to this conversation.
Format: [score%] [date] [salience/category] content {item_id}

Score: >70% strong match, 30-50% tangential. Weight accordingly.
Current conversation context takes priority over stored memories.
These are cross-session signposts — use cortex_search or conversation history tools to find full context behind any memory.

Category guide:
- identity: Core self-concept. Stable but verify against observed behavior.
- preferences/decisions: Apply when relevant. Newer entries supersede older ones.
- goals: Check date — past deadlines may mean completed or abandoned. Confirm if unsure.
- episodic: Past events. Date-sensitive. Reference only when directly relevant.
- behavioral/relational: Patterns and tone context. Descriptive, not prescriptive.

Rules:
- If memories contradict each other, prefer the more recent one or ask.
- If a memory contradicts what you observe in this conversation, trust the conversation.
- Surface relevant context naturally — don't force irrelevant memories into responses.
- Never expose item_ids, scores, or metadata to the user.
- Use cortex_search with keywords or {item_id} to look up more context.`;

function normalizeText(text: string | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textTokens(text: string | undefined): string[] {
  return normalizeText(text).split(" ").filter(Boolean);
}

function overlapRatio(left: string | undefined, right: string | undefined): number {
  const leftSet = new Set(textTokens(left));
  const rightSet = new Set(textTokens(right));
  if (!leftSet.size || !rightSet.size) return 0;

  let shared = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) shared++;
  }
  return shared / Math.max(leftSet.size, rightSet.size);
}

function canonicalSubjectPredicate(item: RetrievedItem): string {
  const provenance = normalizeText(item.provenance);
  if (provenance) return provenance;

  const category = normalizeText(item.metadata?.category);
  const tokens = textTokens(item.content);
  const subject = tokens[0] ?? "";
  const importantTokens = tokens.slice(1).filter(token => token.length >= 4 && ![
    "decided", "plans", "plan", "implement", "prioritize", "priority", "first", "next", "build", "about", "with", "from", "into",
  ].includes(token));
  return [category, subject, ...importantTokens.slice(0, 2)].filter(Boolean).join("|");
}

function sharedEntityHint(current: RetrievedItem, previous: RetrievedItem): string | null {
  const currentTokens = textTokens(current.content);
  const previousTokens = new Set(textTokens(previous.content));
  const shared = currentTokens.filter(token => previousTokens.has(token) && token.length >= 4);
  if (shared.length === 0) return null;
  const currentText = normalizeText(current.content);
  const previousText = normalizeText(previous.content);
  if (
    currentText.includes("plan") ||
    currentText.includes("next") ||
    previousText.includes("decid") ||
    shared.includes("priority")
  ) {
    return "Related to above, may be an update";
  }
  return "Related to above";
}

export function preprocessClaims(
  items: RetrievedItem[],
  options: Pick<EvaMemoryConfig, "showConflicts" | "showRelations" | "dedup">,
): ProcessedItem[] {
  const sorted = [...items].sort((a, b) => {
    const parsedA = a.created_at ? Date.parse(a.created_at) : 0;
    const parsedB = b.created_at ? Date.parse(b.created_at) : 0;
    const dateA = Number.isFinite(parsedA) ? parsedA : 0;
    const dateB = Number.isFinite(parsedB) ? parsedB : 0;
    if (dateA !== dateB) return dateB - dateA;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  const processed: ProcessedItem[] = [];
  const groups = new Map<string, ProcessedItem[]>();

  for (const item of sorted) {
    const key = canonicalSubjectPredicate(item);
    const group = groups.get(key) ?? [];

    let duplicateOf: ProcessedItem | null = null;
    if (options.dedup) {
      for (const existing of group) {
        if (overlapRatio(existing.item.content, item.content) >= 0.8) {
          duplicateOf = existing;
          break;
        }
      }
    }

    if (duplicateOf) {
      duplicateOf.duplicateCount += 1;
      continue;
    }

    const entry: ProcessedItem = {
      item,
      duplicateCount: 1,
    };

    if (options.showConflicts) {
      for (const existing of group) {
        if (overlapRatio(existing.item.content, item.content) < 0.8) {
          entry.conflictWithId = existing.item.item_id?.slice(0, 8);
          break;
        }
      }
    }

    if (options.showRelations && processed.length > 0) {
      const previous = processed[processed.length - 1]?.item;
      if (previous) {
        entry.relationHint = sharedEntityHint(item, previous) ?? undefined;
      }
    }

    group.push(entry);
    groups.set(key, group);
    processed.push(entry);
  }

  return processed;
}

function formatMemoryLine(item: RetrievedItem, processed?: ProcessedItem): string {
  const tag = item.source === "cornerstone" ? " [cornerstone]" : "";
  const score = typeof item.score === "number" && Number.isFinite(item.score)
    ? `[${Math.round(item.score * 100)}%]`
    : "";
  const date = item.created_at ? `[${item.created_at.slice(0, 10)}]` : "";
  const salience = item.metadata?.salience ?? "";
  const category = item.metadata?.category ?? "";
  const meta = [salience, category].filter(Boolean).join("/");
  const metaTag = meta ? `[${meta}]` : "";
  const parts = [score, date, metaTag].filter(Boolean).join(" ");
  const seen = processed && processed.duplicateCount > 1 ? ` [seen ${processed.duplicateCount}x]` : "";
  const conflict = processed?.conflictWithId ? ` ⚠️ Conflicts with: {${processed.conflictWithId}}` : "";
  const idSuffix = item.item_id ? ` {${item.item_id.slice(0, 8)}}` : "";
  return parts
    ? `- ${parts} ${item.content}${tag}${seen}${conflict}${idSuffix}`
    : `- ${item.content}${tag}${seen}${conflict}${idSuffix}`;
}

function formatMemoryContextV1(
  items: RetrievedItem[],
  maxChars: number,
  totalCount = items.length,
  maxCount = 8,
  minScore = 0.25,
): string {
  if (!items.length) return "";

  const relevant = items.filter(item => (item.score ?? 1.0) >= minScore);
  if (!relevant.length) return "";

  const lines: string[] = ["<relevant-memories>", MEMORY_PREAMBLE];
  let charCount = MEMORY_PREAMBLE.length;
  let injectedCount = 0;

  for (const item of relevant.slice(0, maxCount)) {
    const tag = item.source === "cornerstone" ? " [cornerstone]" : "";
    const id = item.item_id ? `[${item.item_id.slice(0, 8)}]` : "";
    const date = item.created_at ? `[${item.created_at.slice(0, 10)}]` : "";
    const salience = item.metadata?.salience ?? "";
    const category = item.metadata?.category ?? "";
    const meta = [salience, category].filter(Boolean).join("/");
    const metaTag = meta ? `[${meta}]` : "";
    const prefix = [id, date, metaTag].filter(Boolean).join(" ");
    const line = prefix
      ? `- ${prefix} ${item.content}${tag}`
      : `- ${item.content}${tag}`;
    if (charCount + line.length > maxChars) break;
    lines.push(line);
    charCount += line.length;
    injectedCount++;
  }

  if (lines.length <= 2) return "";
  lines.push(`[${injectedCount} of ${totalCount} memories shown — use cortex_search for more]`);
  lines.push("</relevant-memories>");
  return lines.join("\n");
}

function formatMemoryContextV2(
  items: RetrievedItem[],
  maxChars: number,
  totalCount = items.length,
  maxCount = 8,
  minScore = 0.25,
  options: Pick<EvaMemoryConfig, "injectionFormat" | "showConflicts" | "showRelations" | "dedup">,
): string {
  if (!items.length) return "";

  const relevant = items.filter(item => (item.score ?? 1.0) >= minScore);
  if (!relevant.length) return "";

  const lines: string[] = ["<relevant-memories>", MEMORY_PREAMBLE];
  let charCount = MEMORY_PREAMBLE.length;
  let injectedCount = 0;
  const processed = preprocessClaims(relevant, options);
  for (const entry of processed.slice(0, maxCount)) {
    const line = formatMemoryLine(entry.item, entry);
    const relationLine = entry.relationHint ? `  ↳ ${entry.relationHint}` : "";
    const needed = line.length + (relationLine ? relationLine.length + 1 : 0);
    if (charCount + needed > maxChars) break;
    lines.push(line);
    if (relationLine) lines.push(relationLine);
    charCount += needed;
    injectedCount++;
  }

  if (lines.length <= 2) return "";
  lines.push(`[${injectedCount} of ${totalCount} memories shown — use cortex_search for more]`);
  lines.push("</relevant-memories>");
  return lines.join("\n");
}

export function formatMemoryContext(
  items: RetrievedItem[],
  maxChars: number,
  totalCount = items.length,
  maxCount = 8,
  minScore = 0.25,
  options: Pick<EvaMemoryConfig, "injectionFormat" | "showConflicts" | "showRelations" | "dedup"> = {
    injectionFormat: "v1",
    showConflicts: true,
    showRelations: true,
    dedup: true,
  },
): string {
  return options.injectionFormat === "v2"
    ? formatMemoryContextV2(items, maxChars, totalCount, maxCount, minScore, options)
    : formatMemoryContextV1(items, maxChars, totalCount, maxCount, minScore);
}

// --- Message extraction (with junk filter) ---

function extractMessages(rawMessages: unknown[]): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];

  for (const msg of rawMessages.slice(-10)) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "user" && m.role !== "assistant") continue;

    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === "object" && "text" in block) {
          const t = (block as Record<string, unknown>).text;
          if (typeof t === "string") text += (text ? "\n" : "") + t;
        }
      }
    }

    // Strip previously injected memory context
    text = text
      .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "")
      .trim();

    if (!text) continue;

    const role = m.role as string;

    // --- Junk filter: drop noise before it reaches Cortex ---

    // Skip assistant messages that are just raw JSON dumps (recall dumps being re-captured)
    if (role === "assistant" && /^\s*\[?\s*\{"\s*role/.test(text)) continue;

    // Skip user messages matching trivial/continuation patterns
    if (role === "user" && TRIVIAL_CAPTURE_PATTERNS.some((p) => p.test(text))) continue;

    result.push({ role, content: text });
  }

  return result;
}

// --- Plugin Definition ---

const cortexPlugin = {
  id: "cortex",
  name: "Memory (Cortex)",
  description: "Cortex memory engine — retrieval, storage, and lifecycle management",
  kind: "memory" as const,

  configSchema: {
    parse: parseConfig,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cortexUrl: { type: "string" },
        apiKey: { type: "string" },
        ownerId: { type: "string" },
        autoRecall: { type: "boolean" },
        autoCapture: { type: "boolean" },
        shadowMode: { type: "boolean", description: "Shadow mode — capture runs extraction but skips storage (dry-run)" },
        retrievalBudget: { type: "number" },
        maxInjectionChars: { type: "number" },
        maxInjectedMemories: { type: "number", description: "Max memories to inject per turn (default: 8)" },
        minRelevanceScore: { type: "number", description: "Min score to inject a memory (default: 0.25)" },
        retrievalMode: { type: "string", enum: ["auto", "fast", "thorough"], description: "Retrieval mode for memory search (default: auto)" },
        recencyFilterMinutes: { type: "number", description: "Filter out memories created within this many minutes to suppress echo (default: 15, 0 to disable)" },
        injectionFormat: { type: "string", enum: ["v1", "v2"], description: "Memory injection formatter version. Default: v1 for backward compatibility." },
        showConflicts: { type: "boolean", description: "Annotate conflicting claims in v2 formatting. Default: true." },
        showRelations: { type: "boolean", description: "Annotate related claims in v2 formatting. Default: true." },
        dedup: { type: "boolean", description: "Collapse near-duplicate claims in v2 formatting. Default: true." },
        enableInjectionScreening: { type: "boolean", description: "Enable two-layer injection screening (R-417/R-418). Default: true. Set false to debug." },
        injectionHardFloor: { type: "number", description: "Hard score floor — drop memories below this regardless of mode (default: 0.50)" },
        injectionCriticalThreshold: { type: "number", description: "Min score in critical mode (bench runs, deploys) (default: 0.75)" },
        injectionTechnicalThreshold: { type: "number", description: "Min score in technical mode (coding, debug) (default: 0.60)" },
        injectionPersonalThreshold: { type: "number", description: "Min score in personal/casual mode (default: 0.45)" },
      },
      required: [],
    },
  },

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    
    if (cfg.apiKey && !cfg.apiKey.startsWith("${")) {
      api.logger.warn("cortex: API key appears to be hardcoded in config. Consider using environment variable: apiKey: '${CORTEX_API_KEY}'");
    }

    const client = new CortexClient(cfg.cortexUrl, cfg.apiKey, cfg.ownerId, (msg) => api.logger.warn(msg));

    // --- Local memory cache ---
    let memoryCache: LocalMemoryCache | null = null;
    let syncInterval: ReturnType<typeof setInterval> | null = null;
    const CACHE_SYNC_INTERVAL_MS = 300000; // 5 minutes

    if (NodeDatabaseSync) {
      try {
        // Resolve cache path relative to this plugin file
        const pluginDir = typeof __dirname === "string" ? __dirname : dirname(__filename);
        const cachePath = join(pluginDir, "cache", `memories-${cfg.ownerId || "default"}.db`);
        memoryCache = new LocalMemoryCache(cachePath);
        api.logger.info(`cortex: local memory cache initialized at ${cachePath} (${memoryCache.getCount()} entries)`);
      } catch (err) {
        api.logger.warn(`cortex: failed to initialize local cache: ${String(err)} — falling back to API-only`);
        memoryCache = null;
      }
    } else {
      api.logger.info("cortex: node:sqlite not available — local cache disabled");
    }

    // Security: warn if API key is hardcoded in config instead of env var
    if (cfg.apiKey && !cfg.apiKey.startsWith("${")) {
      api.logger.warn("cortex: API key appears to be hardcoded in config. Consider using environment variable: apiKey: '${CORTEX_API_KEY}'");
    }

    api.logger.info(
      `cortex: registered (cortex=${cfg.cortexUrl}, owner=${cfg.ownerId}, recall=${cfg.autoRecall}, capture=${cfg.autoCapture}, shadow=${cfg.shadowMode})`,
    );

    // -------------------------------------------------------------------------
    // Tools
    // -------------------------------------------------------------------------

    api.registerTool(
      {
        name: "cortex_search",
        label: "Cortex Search",
        description: "Search long-term memories stored in Cortex. Use when you need context about past decisions, preferences, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { query, limit } = params as { query: string; limit?: number };
          try {
            const result = await client.search(query, limit ?? 10);
            if (!result || !result.items?.length) {
              return { content: [{ type: "text" as const, text: "No memories found." }] };
            }
            const text = result.items
              .map((item, i) => {
                const content = item.content ?? item.text ?? "";
                const id = item.id ?? item.memory_id ?? "";
                const score = typeof item.score === "number" ? ` (${(Number(item.score) * 100).toFixed(0)}%)` : "";
                const date = item.created_at ? ` [${String(item.created_at).slice(0, 10)}]` : "";
                const salience = (item.metadata as any)?.salience ?? "";
                const category = (item.metadata as any)?.category ?? "";
                const meta = [salience, category].filter(Boolean).join("/");
                const metaTag = meta ? ` [${meta}]` : "";
                return `${i + 1}. ${content}${score}${date}${metaTag} (id: ${id})`;
              })
              .join("\n");
            return { content: [{ type: "text" as const, text: `Found ${result.items.length} memories:\n\n${text}` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Search failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_search" },
    );

    api.registerTool(
      {
        name: "cortex_remember",
        label: "Cortex Remember",
        description: "Store an important fact or preference in long-term memory via Cortex.",
        parameters: Type.Object({
          content: Type.String({ description: "Information to remember" }),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { content } = params as { content: string };
          try {
            client.remember([{ role: "user", content }]);
            const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
            return { content: [{ type: "text" as const, text: `Sent to Cortex: "${preview}"` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Remember failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_remember" },
    );

    api.registerTool(
      {
        name: "cortex_forget",
        label: "Cortex Forget",
        description: "Delete a specific memory by ID. Use cortex_search first to find the ID.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "Memory ID to delete" }),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { memory_id } = params as { memory_id: string };
          try {
            const result = await client.forget(memory_id);
            if (!result) {
              return { content: [{ type: "text" as const, text: `Failed to delete memory ${memory_id}` }] };
            }
            // Mark deleted in local cache too
            if (memoryCache) {
              try { memoryCache.markDeleted(memory_id); } catch { /* ignore cache errors */ }
            }
            return { content: [{ type: "text" as const, text: `Memory ${memory_id} deleted.` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Forget failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_forget" },
    );

    api.registerTool(
      {
        name: "cortex_ask",
        label: "Cortex Ask",
        description: "Ask a question answered using the user's stored memories. Returns an LLM-synthesized answer grounded in memory.",
        parameters: Type.Object({
          question: Type.String({ description: "Natural-language question to answer from memory" }),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
          limit: Type.Optional(Type.Number({ description: "Max retrieval steps (default: 5)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { question, owner_id, limit } = params as { question: string; owner_id?: string; limit?: number };
          try {
            const result = await client.ask(question, owner_id, limit ?? 5);
            if (!result || !result.ok) {
              return { content: [{ type: "text" as const, text: "No answer found — Cortex returned no result." }] };
            }
            let text = result.answer;
            if (result.sources?.length) {
              const srcLines = (result.sources as Record<string, unknown>[])
                .map((s, i) => `${i + 1}. ${s.content ?? s.item_id ?? s.id ?? ""} (id: ${s.item_id ?? s.id ?? ""})`)
                .join("\n");
              text += `\n\nSources:\n${srcLines}`;
            }
            return { content: [{ type: "text" as const, text }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Ask failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_ask" },
    );

    api.registerTool(
      {
        name: "cortex_list_contradictions",
        label: "Cortex List Contradictions",
        description: "List detected contradictions between stored memories. Use for memory hygiene audits.",
        parameters: Type.Object({
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { owner_id } = params as { owner_id?: string };
          try {
            const result = await client.listContradictions(owner_id);
            if (!result) {
              return { content: [{ type: "text" as const, text: "Failed to fetch contradictions." }] };
            }
            const items = result.items ?? (result as unknown as Record<string, unknown>[]);
            if (!Array.isArray(items) || !items.length) {
              return { content: [{ type: "text" as const, text: "No contradictions found." }] };
            }
            const text = items
              .map((c, i) => `${i + 1}. [${c.id}] ${c.description ?? c.summary ?? JSON.stringify(c)}`)
              .join("\n");
            return { content: [{ type: "text" as const, text: `Found ${items.length} contradiction(s):\n\n${text}` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `List contradictions failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_list_contradictions" },
    );

    api.registerTool(
      {
        name: "cortex_resolve_contradiction",
        label: "Cortex Resolve Contradiction",
        description: "Resolve a flagged memory contradiction by ID. Use cortex_list_contradictions first to get the ID.",
        parameters: Type.Object({
          id: Type.String({ description: "Contradiction ID to resolve" }),
          resolution: Type.String({ description: "Resolution explanation (e.g. 'newer memory is correct')" }),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { id, resolution, owner_id } = params as { id: string; resolution: string; owner_id?: string };
          try {
            const result = await client.resolveContradiction(id, resolution, owner_id);
            if (!result) {
              return { content: [{ type: "text" as const, text: `Failed to resolve contradiction ${id}.` }] };
            }
            return { content: [{ type: "text" as const, text: `Contradiction ${id} resolved.` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Resolve contradiction failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_resolve_contradiction" },
    );

    api.registerTool(
      {
        name: "cortex_add_commitment",
        label: "Cortex Add Commitment",
        description: "Track a new commitment or promise in Cortex. Use for accountability and follow-up.",
        parameters: Type.Object({
          description: Type.String({ description: "What was committed to" }),
          due_at: Type.Optional(Type.String({ description: "ISO 8601 due date/time (e.g. 2026-03-14T00:00:00Z)" })),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { description, due_at, owner_id } = params as { description: string; due_at?: string; owner_id?: string };
          try {
            const result = await client.addCommitment(description, due_at, owner_id);
            if (!result) {
              return { content: [{ type: "text" as const, text: "Failed to create commitment." }] };
            }
            const id = (result as Record<string, unknown>).id ?? "";
            return { content: [{ type: "text" as const, text: `Commitment created${id ? ` (id: ${id})` : ""}: "${description}"` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Add commitment failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_add_commitment" },
    );

    api.registerTool(
      {
        name: "cortex_update_commitment",
        label: "Cortex Update Commitment",
        description: "Update the status of an existing commitment (e.g. mark as completed or cancelled).",
        parameters: Type.Object({
          id: Type.String({ description: "Commitment ID to update" }),
          status: Type.String({ description: "New status: completed or cancelled" }),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { id, status, owner_id } = params as { id: string; status: string; owner_id?: string };
          try {
            const result = await client.updateCommitment(id, status, owner_id);
            if (!result) {
              return { content: [{ type: "text" as const, text: `Failed to update commitment ${id}.` }] };
            }
            return { content: [{ type: "text" as const, text: `Commitment ${id} updated to "${status}".` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Update commitment failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_update_commitment" },
    );

    api.registerTool(
      {
        name: "cortex_list_commitments",
        label: "Cortex List Commitments",
        description: "List active or all commitments tracked in Cortex.",
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: "Filter by status: active, completed, cancelled" })),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { status, owner_id } = params as { status?: string; owner_id?: string };
          try {
            const result = await client.listCommitments(owner_id, status);
            if (!result) {
              return { content: [{ type: "text" as const, text: "Failed to fetch commitments." }] };
            }
            const items = (result as any)?.commitments ?? (Array.isArray(result) ? result : []);
            if (!items.length) {
              return { content: [{ type: "text" as const, text: "No commitments found." }] };
            }
            const text = items
              .map((c: any, i: number) => {
                const due = c.due_at ? ` (due: ${c.due_at})` : "";
                return `${i + 1}. [${c.id}] [${c.status}] ${c.content ?? c.description}${due}`;
              })
              .join("\n");
            return { content: [{ type: "text" as const, text: `Found ${items.length} commitment(s):\n\n${text}` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `List commitments failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_list_commitments" },
    );

    api.registerTool(
      {
        name: "cortex_insights",
        label: "Cortex Insights",
        description: "List cross-system insights from behavioral + memory analysis. Shows patterns, correlations, and recommendations discovered by the dreaming engine.",
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: "Filter by status: pending, accepted, or all" })),
          limit: Type.Optional(Type.Number({ description: "Max results to return (default: 5)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { status, limit } = params as { status?: string; limit?: number };
          try {
            const result = await client.listInsights(status ?? "pending", limit ?? 5);
            if (!result) {
              return { content: [{ type: "text" as const, text: "Failed to fetch insights." }] };
            }
            const items = (result as any)?.insights ?? [];
            if (!items.length) {
              return { content: [{ type: "text" as const, text: "No insights found." }] };
            }
            const text = items
              .map((insight: any, i: number) => {
                const conf = typeof insight.confidence === "number" ? ` (${Math.round(insight.confidence * 100)}%)` : "";
                const type = insight.insight_type ? ` [${insight.insight_type}]` : "";
                const statusTag = insight.status ? ` [${insight.status}]` : "";
                return `${i + 1}. ${insight.insight ?? insight.content ?? JSON.stringify(insight)}${conf}${type}${statusTag}`;
              })
              .join("\n");
            return { content: [{ type: "text" as const, text: `Found ${items.length} insight(s):\n\n${text}` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `List insights failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_insights" },
    );

    api.registerTool(
      {
        name: "company_brain_accounts_list",
        label: "Company Brain Accounts List",
        description: "List or search source-backed Company Brain accounts through the Cortex HTTP API. Use this first to resolve stable account IDs before brief, timeline, or query calls.",
        parameters: Type.Object({
          search: Type.Optional(Type.String({ description: "Optional account/workspace search text" })),
          workspace_id: Type.Optional(Type.String({ description: "Optional Cortex Company Brain workspace ID" })),
          limit: Type.Optional(Type.Number({ description: "Max accounts to return, 1-200 (default: 50)" })),
          offset: Type.Optional(Type.Number({ description: "Zero-based account offset (default: 0)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { search, workspace_id, limit, offset } = params as {
            search?: string;
            workspace_id?: string;
            limit?: number;
            offset?: number;
          };
          try {
            const result = await client.listCompanyBrainAccounts({
              search,
              workspaceId: workspace_id,
              limit,
              offset,
            });
            return { content: [{ type: "text" as const, text: formatCompanyBrainToolResult("Company Brain accounts", result) }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Company Brain account list failed: ${String(err)}` }] };
          }
        },
      },
      { name: "company_brain_accounts_list" },
    );

    api.registerTool(
      {
        name: "company_brain_account_brief",
        label: "Company Brain Account Brief",
        description: "Fetch a source-backed Company Brain account brief. `insufficient_evidence` is an honest successful result, not a tool failure.",
        parameters: Type.Object({
          account_id: Type.String({ description: "Stable Company Brain account ID from company_brain_accounts_list" }),
          facts_limit: Type.Optional(Type.Number({ description: "Max facts to return, 1-200 (default: 50)" })),
          facts_offset: Type.Optional(Type.Number({ description: "Zero-based fact offset (default: 0)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { account_id, facts_limit, facts_offset } = params as {
            account_id: string;
            facts_limit?: number;
            facts_offset?: number;
          };
          try {
            const result = await client.getCompanyBrainAccountBrief(account_id, {
              factsLimit: facts_limit,
              factsOffset: facts_offset,
            });
            return { content: [{ type: "text" as const, text: formatCompanyBrainToolResult("Company Brain account brief", result) }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Company Brain account brief failed: ${String(err)}` }] };
          }
        },
      },
      { name: "company_brain_account_brief" },
    );

    api.registerTool(
      {
        name: "company_brain_account_timeline",
        label: "Company Brain Account Timeline",
        description: "Fetch source artifact and claim events for one Company Brain account, preserving citations and timeline pagination.",
        parameters: Type.Object({
          account_id: Type.String({ description: "Stable Company Brain account ID from company_brain_accounts_list" }),
          limit: Type.Optional(Type.Number({ description: "Max timeline items to return, 1-200 (default: 50)" })),
          offset: Type.Optional(Type.Number({ description: "Zero-based timeline offset (default: 0)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { account_id, limit, offset } = params as {
            account_id: string;
            limit?: number;
            offset?: number;
          };
          try {
            const result = await client.getCompanyBrainAccountTimeline(account_id, { limit, offset });
            return { content: [{ type: "text" as const, text: formatCompanyBrainToolResult("Company Brain account timeline", result) }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Company Brain account timeline failed: ${String(err)}` }] };
          }
        },
      },
      { name: "company_brain_account_timeline" },
    );

    api.registerTool(
      {
        name: "company_brain_query",
        label: "Company Brain Query",
        description: "Ask a narrow Company Brain pilot question for one resolved account. Answers must be source-cited or return `insufficient_evidence`; the tool never performs outbound action.",
        parameters: Type.Object({
          account_id: Type.String({ description: "Stable Company Brain account ID from company_brain_accounts_list" }),
          intent: Type.Optional(Type.Union([
            Type.Literal("auto"),
            Type.Literal("account_brief"),
            Type.Literal("daily_brief"),
            Type.Literal("what_changed"),
            Type.Literal("follow_ups"),
            Type.Literal("blocked"),
            Type.Literal("open_loops"),
          ], { description: "Narrow deterministic Company Brain query intent" })),
          question: Type.Optional(Type.String({ description: "Optional natural-language question for auto routing" })),
          limit: Type.Optional(Type.Number({ description: "Max facts/events to cite, 1-50 (default: 10)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { account_id, intent, question, limit } = params as {
            account_id: string;
            intent?: CompanyBrainQueryIntent;
            question?: string;
            limit?: number;
          };
          try {
            const result = await client.queryCompanyBrain({
              accountId: account_id,
              intent,
              question,
              limit,
            });
            return { content: [{ type: "text" as const, text: formatCompanyBrainToolResult("Company Brain query", result) }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Company Brain query failed: ${String(err)}` }] };
          }
        },
      },
      { name: "company_brain_query" },
    );

    api.registerTool(
      {
        name: "cortex_add_open_loop",
        label: "Cortex Add Open Loop",
        description: "Create an open loop (unresolved thread) in Cortex. Use to track topics or threads left unfinished.",
        parameters: Type.Object({
          description: Type.String({ description: "Description of the unresolved thread or topic" }),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { description, owner_id } = params as { description: string; owner_id?: string };
          try {
            const result = await client.addOpenLoop(description, owner_id);
            if (!result) {
              return { content: [{ type: "text" as const, text: "Failed to create open loop." }] };
            }
            const id = (result as Record<string, unknown>).id ?? "";
            return { content: [{ type: "text" as const, text: `Open loop created${id ? ` (id: ${id})` : ""}: "${description}"` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Add open loop failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_add_open_loop" },
    );

    api.registerTool(
      {
        name: "cortex_resolve_open_loop",
        label: "Cortex Resolve Open Loop",
        description: "Mark an open loop as resolved.",
        parameters: Type.Object({
          id: Type.String({ description: "Open loop ID to resolve" }),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { id, owner_id } = params as { id: string; owner_id?: string };
          try {
            const result = await client.resolveOpenLoop(id, owner_id);
            if (!result) {
              return { content: [{ type: "text" as const, text: `Failed to resolve open loop ${id}.` }] };
            }
            return { content: [{ type: "text" as const, text: `Open loop ${id} resolved.` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `Resolve open loop failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_resolve_open_loop" },
    );

    api.registerTool(
      {
        name: "cortex_list_open_loops",
        label: "Cortex List Open Loops",
        description: "List open (unresolved) threads tracked in Cortex.",
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: "Filter by status: open, resolved" })),
          owner_id: Type.Optional(Type.String({ description: "Memory owner namespace (defaults to configured owner)" })),
        }),
        async execute(_toolCallId: string, params: unknown): Promise<any> {
          const { status, owner_id } = params as { status?: string; owner_id?: string };
          try {
            const result = await client.listOpenLoops(owner_id, status);
            if (!result) {
              return { content: [{ type: "text" as const, text: "Failed to fetch open loops." }] };
            }
            const items = (result as any)?.open_loops ?? (Array.isArray(result) ? result : []);
            if (!items.length) {
              return { content: [{ type: "text" as const, text: "No open loops found." }] };
            }
            const text = items
              .map((l: any, i: number) => `${i + 1}. [${l.id}] [${l.status}] ${l.content ?? l.description}`)
              .join("\n");
            return { content: [{ type: "text" as const, text: `Found ${items.length} open loop(s):\n\n${text}` }] };
          } catch (err) {
            return { content: [{ type: "text" as const, text: `List open loops failed: ${String(err)}` }] };
          }
        },
      },
      { name: "cortex_list_open_loops" },
    );

    // -------------------------------------------------------------------------
    // Hooks
    // -------------------------------------------------------------------------

    // Auto-recall: inject cornerstones (always) + relevant memories (when relevant)
    // Lane guards prevent injection on heartbeat, boot, subagent, cron, isolated lanes.
    // Server-first: always call Cortex API (semantic embeddings). Local cache is fallback only.
    api.on("before_agent_start", async (event, ctx) => {
      const startMs = Date.now();
      const blocks: string[] = [];

      const laneDecision = shouldSkipMemoryInjection(event.prompt, ctx as HookLaneContext);
      if (laneDecision.skip) {
        api.logger.info(`cortex: skipping recall injection for lane=${laneDecision.lane}`);
        return;
      }

      // --- Fetch contextual memories (+ optional cornerstones) ---
      if (cfg.autoRecall) {
        const doRetrieve = event.prompt && isMemoryRelevant(event.prompt);
        const doCornerstones = cfg.injectCornerstones; // default false — cornerstones in SOUL.md

        // --- Memory retrieval (server-first, local fallback) ---
        let memoryItems: RetrievedItem[] = [];
        // usedCache removed — server-first architecture, local cache is fallback only
        let tokensUsed = 0;

        // Server-first architecture: Cortex API has semantic embeddings (Voyage-4-large),
        // local cache is keyword-only fallback for when server is slow/down.
        // Previous design tried cache-first with ≥3 threshold, which effectively
        // bypassed semantic search on every query. Fixed 2026-03-23.

        // If no cache or cache miss: fall back to API retrieval (original path)
        if (doRetrieve) {
          // Fire cornerstones + API retrieve in parallel
          const [cornerstonesResult, retrieveResult] = await Promise.allSettled([
            doCornerstones ? client.getCornerstones() : Promise.resolve(null),
            client.retrieve(event.prompt!, cfg.retrievalBudget, cfg.retrievalMode),
          ]);

          // Process cornerstones
          if (doCornerstones && cornerstonesResult.status === "fulfilled" && cornerstonesResult.value?.length) {
            const csBlock = formatCornerstones(cornerstonesResult.value);
            if (csBlock) {
              blocks.push(csBlock);
              api.logger.info(`cortex: loaded ${cornerstonesResult.value.length} cornerstones`);
            }
          } else if (doCornerstones && cornerstonesResult.status === "rejected") {
            api.logger.warn(`cortex: cornerstone fetch failed: ${String(cornerstonesResult.reason)}`);
          }

          // Process API results
          if (retrieveResult.status === "fulfilled" && retrieveResult.value?.items?.length) {
            const result = retrieveResult.value;
            memoryItems = result.items;
            tokensUsed = result.tokens_used ?? 0;
            // Cache the API results for next time
            if (memoryCache) {
              try { memoryCache.upsertBatch(result.items); } catch { /* ignore */ }
            }
          } else if (retrieveResult.status === "rejected") {
            api.logger.warn(`cortex: recall failed (${Date.now() - startMs}ms): ${String(retrieveResult.reason)}`);
            // Server down — fall back to local cache if available
            if (memoryCache) {
              try {
                const fallbackResults = memoryCache.search(event.prompt!, 20);
                if (fallbackResults.length) {
                  memoryItems = fallbackResults;
                  api.logger.info(`cortex: using local cache fallback (${fallbackResults.length} results)`);
                }
              } catch { /* ignore fallback errors */ }
            }
          }
        } else if (!doRetrieve && doCornerstones) {
          // No retrieval needed but cornerstones requested
          const cornerstonesResult = await client.getCornerstones().catch(() => null);
          if (cornerstonesResult?.length) {
            const csBlock = formatCornerstones(cornerstonesResult);
            if (csBlock) {
              blocks.push(csBlock);
              api.logger.info(`cortex: loaded ${cornerstonesResult.length} cornerstones`);
            }
          }
        }

        // Format and inject memories
        if (memoryItems.length) {
          const filtered = filterEchoMemories(memoryItems, ctx.sessionKey, cfg.recencyFilterMinutes);
          if (filtered.length < memoryItems.length) {
            api.logger.info(
              `cortex: echo filter removed ${memoryItems.length - filtered.length} same-session/recent memories`,
            );
          }
          // Injection screening (R-417 / R-418): hard rules + confidence gate
          const screened = cfg.enableInjectionScreening
            ? screenInjectionCandidates(filtered, event.prompt ?? "", cfg, (msg) => api.logger.info(msg))
            : filtered;
          const context = formatMemoryContext(
            screened,
            cfg.maxInjectionChars,
            filtered.length,
            cfg.maxInjectedMemories,
            cfg.minRelevanceScore,
            {
              injectionFormat: cfg.injectionFormat,
              showConflicts: cfg.showConflicts,
              showRelations: cfg.showRelations,
              dedup: cfg.dedup,
            },
          );
          if (context) {
            const elapsed = Date.now() - startMs;
            if (elapsed <= 3000) {
              blocks.push(context);
              const source = "API";
              api.logger.info(
                `cortex: injecting ${filtered.length} memories from ${source} (${tokensUsed} tokens, ${elapsed}ms)`,
              );
            } else {
              api.logger.warn(`cortex: retrieval took ${elapsed}ms, skipping memory injection (cornerstones still injected)`);
            }
          }
        }
      }

      if (blocks.length) {
        return { prependContext: blocks.join("\n\n") };
      }
    });

    // Auto-capture: store conversation after agent ends (fire and forget)
    // Applies junk pre-filter and lane guards before calling remember().
    if (cfg.autoCapture) {
      api.on("agent_end", (event, ctx) => {
        if (!event.success || !event.messages?.length) return;

        // Skip noisy sessions (subagents, crons, isolated, heartbeats, boot checks)
        const key = ctx.sessionKey ?? "";
        if (key.includes(":subagent:") || key.includes(":cron:") || key.includes(":isolated:")) return;
        const hookCtx = ctx as HookLaneContext;
        if (hookCtx.isHeartbeat) return;

        const messages = extractMessages(event.messages);

        // Require at least 2 real messages — single-message captures are noise
        if (messages.length < 2) return;

        const joined = messages.map((m) => m.content).join("\n");
        if (isBootPrompt(joined) || /HEARTBEAT_OK/i.test(joined) || /Read HEARTBEAT\.md if it exists/i.test(joined)) return;
        // Skip system events (sub-agent completions, exec notifications) — not worth extracting
        if (SYSTEM_EVENT_PATTERNS.test(joined)) return;

        // Fire and forget — no await, no blocking
        const capturePromise = client.remember(messages, ctx.sessionKey, cfg.shadowMode);
        if (capturePromise && typeof capturePromise.catch === "function") {
          capturePromise.catch((err: unknown) => {
            api.logger.warn(`cortex: capture failed: ${String(err)}`);
          });
        }
        if (cfg.shadowMode) {
          api.logger.info(`cortex: [shadow] captured ${messages.length} messages (session=${ctx.sessionKey})`);
        }
      });
    }

    // Session lifecycle (non-blocking)
    api.on("session_start", (event) => {
      client.wake(event.sessionId);
    });

    api.on("session_end", (event) => {
      client.sleep(event.sessionId);
    });

    // -------------------------------------------------------------------------
    // Service
    // -------------------------------------------------------------------------

    api.registerService({
      id: "cortex",
      async start() {
        const healthy = await client.health();
        if (healthy) {
          api.logger.info(`cortex: Cortex is reachable at ${cfg.cortexUrl}`);
        } else {
          api.logger.warn(`cortex: Cortex unreachable at ${cfg.cortexUrl} — will retry on first use`);
        }
        // Start background cache sync
        if (memoryCache && healthy) {
          // Initial sync (non-blocking)
          syncMemoryCache(client, memoryCache, api.logger).catch(() => {});
          // Periodic sync every 5 minutes
          syncInterval = setInterval(() => {
            if (memoryCache) {
              syncMemoryCache(client, memoryCache, api.logger).catch(() => {});
            }
          }, CACHE_SYNC_INTERVAL_MS);
        }
      },
      stop() {
        // Clean up sync interval and close cache
        if (syncInterval) {
          clearInterval(syncInterval);
          syncInterval = null;
        }
        if (memoryCache) {
          memoryCache.close();
          memoryCache = null;
        }
        api.logger.info("cortex: stopped");
      },
    });

    // -------------------------------------------------------------------------
    // CLI
    // -------------------------------------------------------------------------

    api.registerCli(
      ({ program }) => {
        const cortex = program.command("cortex").description("Cortex memory commands");

        cortex
          .command("health")
          .description("Check Cortex connectivity")
          .action(async () => {
            const ok = await client.health();
            console.log(ok ? "✅ Cortex is healthy" : "❌ Cortex is unreachable");
            process.exitCode = ok ? 0 : 1;
          });

        cortex
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "10")
          .action(async (query: string, opts: { limit: string }) => {
            const result = await client.search(query, parseInt(opts.limit, 10));
            if (!result?.items?.length) {
              console.log("No memories found.");
              return;
            }
            console.log(JSON.stringify(result.items, null, 2));
          });
      },
      { commands: ["cortex"] },
    );
  },
};

export default cortexPlugin;
