"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const index_1 = require("../index");
{
    const cfg = (0, index_1.parseEvaMemoryConfig)({
        companyBrainContextMode: "auto",
        companyBrainContextAccountId: "acct_acme",
        companyBrainContextSearch: "Acme Clinic",
        companyBrainContextFactsLimit: 12,
        companyBrainContextEventsLimit: 7,
        companyBrainContextMaxChars: 5000,
    });
    strict_1.default.equal(cfg.companyBrainContextMode, "auto");
    strict_1.default.equal(cfg.companyBrainContextAccountId, "acct_acme");
    strict_1.default.equal(cfg.companyBrainContextSearch, "Acme Clinic");
    strict_1.default.equal(cfg.companyBrainContextFactsLimit, 12);
    strict_1.default.equal(cfg.companyBrainContextEventsLimit, 7);
    strict_1.default.equal(cfg.companyBrainContextMaxChars, 5000);
}
{
    const rendered = (0, index_1.formatCompanyBrainContext)({
        account: {
            id: "acct_acme",
            name: "Acme Clinic",
            visibility_scope: "account",
        },
        brief: {
            ok: true,
            evidence_status: "source_backed",
            visibility_scope: "account",
            facts: [
                {
                    claim_id: "claim_1",
                    claim: "Acme asked for a Monday scheduling follow-up.",
                    verification_status: "source_backed",
                    visibility_scope: "account",
                    citations: [
                        {
                            artifact_id: "ba_gmail_thread_551",
                            source_system: "gmail",
                            quote: "Monday works best.",
                        },
                    ],
                },
            ],
            follow_ups: [
                {
                    claim_id: "claim_followup_551",
                    requires_approval: true,
                    action_readiness: "draft_ready",
                    verification_status: "source_backed",
                    visibility_scope: "operator",
                    citations: [
                        {
                            artifact_id: "ba_gmail_thread_551",
                            source_system: "gmail",
                        },
                    ],
                },
            ],
            shadow_context: {
                source: "gbrain",
                authoritative: false,
                visibility_scope: "shadow",
            },
        },
        actionReadiness: {
            ok: true,
            intent: "follow_ups",
            answer: "There is one draft-ready follow-up.",
            insufficient_evidence: false,
            sections: [
                {
                    label: "follow_up",
                    requires_approval: true,
                    action_readiness: "draft_ready",
                    verification_status: "source_backed",
                    visibility_scope: "operator",
                },
            ],
            citations: [
                {
                    artifact_id: "ba_gmail_thread_551",
                    source_system: "gmail",
                },
            ],
        },
    }, { maxChars: 8000 });
    strict_1.default.match(rendered, /<company-brain-context/);
    strict_1.default.match(rendered, /account_id="acct_acme"/);
    strict_1.default.doesNotMatch(rendered, /<relevant-memories>/);
    strict_1.default.match(rendered, /read-only context/i);
    strict_1.default.match(rendered, /approval-gated items are not executable/i);
    strict_1.default.match(rendered, /"executable_actions": \[\]/);
    strict_1.default.match(rendered, /"action_status": "approval_required_not_executable"/);
    strict_1.default.match(rendered, /"requires_approval": true/);
    strict_1.default.match(rendered, /"action_readiness": "draft_ready"/);
    strict_1.default.match(rendered, /"verification_status": "source_backed"/);
    strict_1.default.match(rendered, /"visibility_scope": "operator"/);
    strict_1.default.match(rendered, /"artifact_id": "ba_gmail_thread_551"/);
    strict_1.default.match(rendered, /non-authoritative/i);
}
{
    const rendered = (0, index_1.formatCompanyBrainContext)({
        account: {
            id: "acct_acme",
            name: "Acme Clinic",
        },
        actionReadiness: {
            ok: true,
            evidence_status: "insufficient_evidence",
            insufficient_evidence: true,
            answer: "insufficient_evidence: no source-backed account evidence matched this question.",
            citations: [],
        },
    }, { maxChars: 8000 });
    strict_1.default.match(rendered, /"evidence_status": "insufficient_evidence"/);
    strict_1.default.match(rendered, /"insufficient_evidence": true/);
    strict_1.default.match(rendered, /"citations": \[\]/);
}
console.log("company-brain-context-format tests passed");
//# sourceMappingURL=company-brain-context-format.test.js.map