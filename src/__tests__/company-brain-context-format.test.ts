import assert from "node:assert/strict";
import { formatCompanyBrainContext, parseEvaMemoryConfig } from "../index";

{
  const cfg = parseEvaMemoryConfig({
    companyBrainContextMode: "auto",
    companyBrainContextAccountId: "acct_acme",
    companyBrainContextSearch: "Acme Clinic",
    companyBrainContextFactsLimit: 12,
    companyBrainContextEventsLimit: 7,
    companyBrainContextMaxChars: 5000,
  });

  assert.equal(cfg.companyBrainContextMode, "auto");
  assert.equal(cfg.companyBrainContextAccountId, "acct_acme");
  assert.equal(cfg.companyBrainContextSearch, "Acme Clinic");
  assert.equal(cfg.companyBrainContextFactsLimit, 12);
  assert.equal(cfg.companyBrainContextEventsLimit, 7);
  assert.equal(cfg.companyBrainContextMaxChars, 5000);
}

{
  const rendered = formatCompanyBrainContext({
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

  assert.match(rendered, /<company-brain-context/);
  assert.match(rendered, /account_id="acct_acme"/);
  assert.doesNotMatch(rendered, /<relevant-memories>/);
  assert.match(rendered, /read-only context/i);
  assert.match(rendered, /approval-gated items are not executable/i);
  assert.match(rendered, /"executable_actions": \[\]/);
  assert.match(rendered, /"action_status": "approval_required_not_executable"/);
  assert.match(rendered, /"requires_approval": true/);
  assert.match(rendered, /"action_readiness": "draft_ready"/);
  assert.match(rendered, /"verification_status": "source_backed"/);
  assert.match(rendered, /"visibility_scope": "operator"/);
  assert.match(rendered, /"artifact_id": "ba_gmail_thread_551"/);
  assert.match(rendered, /non-authoritative/i);
}

{
  const rendered = formatCompanyBrainContext({
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

  assert.match(rendered, /"evidence_status": "insufficient_evidence"/);
  assert.match(rendered, /"insufficient_evidence": true/);
  assert.match(rendered, /"citations": \[\]/);
}

console.log("company-brain-context-format tests passed");
