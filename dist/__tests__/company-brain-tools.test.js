"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const index_1 = require("../index");
{
    const cfg = (0, index_1.parseEvaMemoryConfig)({ ownerId: "company-acme" });
    strict_1.default.equal(cfg.ownerId, "company-acme");
}
{
    const rendered = (0, index_1.formatCompanyBrainToolResult)("Company Brain query", {
        ok: true,
        evidence_status: "insufficient_evidence",
        sections: [],
        citations: [],
        answer: "insufficient_evidence: no source-backed evidence matched this pilot query.",
    });
    strict_1.default.match(rendered, /Company Brain query:/);
    strict_1.default.match(rendered, /"evidence_status": "insufficient_evidence"/);
    strict_1.default.match(rendered, /"citations": \[\]/);
}
{
    const rendered = (0, index_1.formatCompanyBrainToolResult)("Company Brain brief", {
        ok: true,
        evidence_status: "source_backed",
        follow_ups: [
            {
                claim_id: "claim_followup_551",
                requires_approval: true,
                action_readiness: "draft_ready",
                verification_status: "source_backed",
                source: {
                    artifact_id: "ba_gmail_thread_551",
                    source_system: "gmail",
                },
            },
        ],
    });
    strict_1.default.match(rendered, /"requires_approval": true/);
    strict_1.default.match(rendered, /"action_readiness": "draft_ready"/);
    strict_1.default.match(rendered, /"artifact_id": "ba_gmail_thread_551"/);
}
{
    strict_1.default.equal((0, index_1.formatCompanyBrainToolResult)("Company Brain accounts", null), "Company Brain accounts failed: Cortex returned no result.");
}
console.log("company-brain-tools tests passed");
//# sourceMappingURL=company-brain-tools.test.js.map