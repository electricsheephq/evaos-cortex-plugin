import assert from "node:assert/strict";
import { formatCompanyBrainToolResult, parseEvaMemoryConfig } from "../index";

{
  const cfg = parseEvaMemoryConfig({ ownerId: "company-acme" });
  assert.equal(cfg.ownerId, "company-acme");
}

{
  const rendered = formatCompanyBrainToolResult("Company Brain query", {
    ok: true,
    evidence_status: "insufficient_evidence",
    sections: [],
    citations: [],
    answer: "insufficient_evidence: no source-backed evidence matched this pilot query.",
  });
  assert.match(rendered, /Company Brain query:/);
  assert.match(rendered, /"evidence_status": "insufficient_evidence"/);
  assert.match(rendered, /"citations": \[\]/);
}

{
  const rendered = formatCompanyBrainToolResult("Company Brain brief", {
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
  assert.match(rendered, /"requires_approval": true/);
  assert.match(rendered, /"action_readiness": "draft_ready"/);
  assert.match(rendered, /"artifact_id": "ba_gmail_thread_551"/);
}

{
  assert.equal(
    formatCompanyBrainToolResult("Company Brain accounts", null),
    "Company Brain accounts failed: Cortex returned no result.",
  );
}

console.log("company-brain-tools tests passed");
