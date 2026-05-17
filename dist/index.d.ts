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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
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
    retrievalMode: string;
    recencyFilterMinutes: number;
    injectCornerstones: boolean;
    injectionFormat: "v1" | "v2";
    showConflicts: boolean;
    showRelations: boolean;
    dedup: boolean;
    enableInjectionScreening: boolean;
    injectionHardFloor: number;
    injectionCriticalThreshold: number;
    injectionTechnicalThreshold: number;
    injectionPersonalThreshold: number;
    companyBrainContextMode: "off" | "auto";
    companyBrainContextAccountId: string;
    companyBrainContextSearch: string;
    companyBrainContextFactsLimit: number;
    companyBrainContextEventsLimit: number;
    companyBrainContextMaxChars: number;
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
type CompanyBrainToolResult = Record<string, unknown>;
interface CompanyBrainContextPayload {
    account?: Record<string, unknown> | null;
    brief?: CompanyBrainToolResult | null;
    actionReadiness?: CompanyBrainToolResult | null;
    resolution?: Record<string, unknown> | null;
}
export interface CompanyBrainResolvedAccount {
    accountId: string;
    account: Record<string, unknown>;
    resolution: Record<string, unknown>;
}
interface ProcessedItem {
    item: RetrievedItem;
    duplicateCount: number;
    conflictWithId?: string;
    relationHint?: string;
}
export declare function formatCompanyBrainToolResult(label: string, result: CompanyBrainToolResult | null): string;
export declare function formatCompanyBrainContext(payload: CompanyBrainContextPayload, options?: {
    maxChars?: number;
}): string;
declare function parseConfig(raw: unknown): EvaMemoryConfig;
export declare function resolveCompanyBrainAccountFromAccountsList(accountsResult: CompanyBrainToolResult | null, options?: {
    configuredAccountId?: string;
    search?: string;
}): CompanyBrainResolvedAccount | null;
/** Session risk mode for dynamic threshold selection. */
type InjectionMode = "critical" | "technical" | "personal";
/** Parse raw plugin config into a validated EvaMemoryConfig object. */
export declare function parseEvaMemoryConfig(raw: unknown): EvaMemoryConfig;
/**
 * Classify the current turn into an injection mode.
 * critical > technical > personal (first match wins).
 */
export declare function detectInjectionMode(promptText: string): InjectionMode;
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
export declare function screenInjectionCandidates(items: RetrievedItem[], promptText: string, cfg: Pick<EvaMemoryConfig, "injectionHardFloor" | "injectionCriticalThreshold" | "injectionTechnicalThreshold" | "injectionPersonalThreshold">, log?: (msg: string) => void): RetrievedItem[];
export declare function preprocessClaims(items: RetrievedItem[], options: Pick<EvaMemoryConfig, "showConflicts" | "showRelations" | "dedup">): ProcessedItem[];
export declare function formatMemoryContext(items: RetrievedItem[], maxChars: number, totalCount?: number, maxCount?: number, minScore?: number, options?: Pick<EvaMemoryConfig, "injectionFormat" | "showConflicts" | "showRelations" | "dedup">): string;
declare const cortexPlugin: {
    id: string;
    name: string;
    description: string;
    kind: "memory";
    configSchema: {
        parse: typeof parseConfig;
        jsonSchema: {
            type: string;
            additionalProperties: boolean;
            properties: {
                cortexUrl: {
                    type: string;
                };
                apiKey: {
                    type: string;
                };
                ownerId: {
                    type: string;
                };
                autoRecall: {
                    type: string;
                };
                autoCapture: {
                    type: string;
                };
                shadowMode: {
                    type: string;
                    description: string;
                };
                retrievalBudget: {
                    type: string;
                };
                maxInjectionChars: {
                    type: string;
                };
                maxInjectedMemories: {
                    type: string;
                    description: string;
                };
                minRelevanceScore: {
                    type: string;
                    description: string;
                };
                retrievalMode: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                recencyFilterMinutes: {
                    type: string;
                    description: string;
                };
                injectionFormat: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                showConflicts: {
                    type: string;
                    description: string;
                };
                showRelations: {
                    type: string;
                    description: string;
                };
                dedup: {
                    type: string;
                    description: string;
                };
                enableInjectionScreening: {
                    type: string;
                    description: string;
                };
                injectionHardFloor: {
                    type: string;
                    description: string;
                };
                injectionCriticalThreshold: {
                    type: string;
                    description: string;
                };
                injectionTechnicalThreshold: {
                    type: string;
                    description: string;
                };
                injectionPersonalThreshold: {
                    type: string;
                    description: string;
                };
                companyBrainContextMode: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                companyBrainContextAccountId: {
                    type: string;
                    description: string;
                };
                companyBrainContextSearch: {
                    type: string;
                    description: string;
                };
                companyBrainContextFactsLimit: {
                    type: string;
                    description: string;
                };
                companyBrainContextEventsLimit: {
                    type: string;
                    description: string;
                };
                companyBrainContextMaxChars: {
                    type: string;
                    description: string;
                };
            };
            required: never[];
        };
    };
    register(api: OpenClawPluginApi): void;
};
export default cortexPlugin;
//# sourceMappingURL=index.d.ts.map