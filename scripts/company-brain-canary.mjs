#!/usr/bin/env node

const cortexUrl = (process.env.CORTEX_URL || "http://localhost:8000").replace(/\/+$/, "");
const apiKey = process.env.CORTEX_API_KEY || "";
const ownerId = process.env.CORTEX_OWNER_ID || "";
let accountId = process.env.COMPANY_BRAIN_ACCOUNT_ID || "";

function headers() {
  const h = { "Content-Type": "application/json" };
  if (apiKey) h["X-API-Key"] = apiKey;
  return h;
}

function withOwner(params) {
  if (ownerId) params.set("owner_id", ownerId);
  return params;
}

async function request(stage, path, options = {}) {
  const res = await fetch(`${cortexUrl}${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${stage} failed with HTTP ${res.status}: ${text}`);
  }
  return body;
}

async function main() {
  const stages = [];
  const accountParams = withOwner(new URLSearchParams({ limit: "5", offset: "0" }));
  const accounts = await request("account_resolution", `/api/v1/company-brain/accounts?${accountParams}`);
  stages.push({
    stage: "account_resolution",
    status: "passed",
    total: accounts?.total ?? 0,
  });

  if (!accountId) {
    accountId = accounts?.accounts?.[0]?.id || "";
  }
  if (!accountId) {
    console.log(JSON.stringify({ ok: true, stages, note: "no accounts found; account-list route/auth smoke passed" }, null, 2));
    return;
  }

  const briefParams = withOwner(new URLSearchParams({ facts_limit: "10", facts_offset: "0" }));
  const brief = await request("brief", `/api/v1/company-brain/accounts/${encodeURIComponent(accountId)}/brief?${briefParams}`);
  stages.push({
    stage: "brief",
    status: "passed",
    evidence_status: brief?.evidence_status,
    facts_total: brief?.facts_total ?? 0,
  });

  const timelineParams = withOwner(new URLSearchParams({ limit: "10", offset: "0" }));
  const timeline = await request("timeline", `/api/v1/company-brain/accounts/${encodeURIComponent(accountId)}/timeline?${timelineParams}`);
  stages.push({
    stage: "timeline",
    status: "passed",
    evidence_status: timeline?.evidence_status,
    total: timeline?.total ?? 0,
  });

  const query = await request("query", "/api/v1/company-brain/query", {
    method: "POST",
    body: JSON.stringify({
      owner_id: ownerId || undefined,
      account_id: accountId,
      intent: "follow_ups",
      question: "Who needs follow-up?",
      limit: 5,
    }),
  });
  stages.push({
    stage: "query",
    status: "passed",
    evidence_status: query?.evidence_status,
    citations: query?.citations?.length ?? 0,
  });

  console.log(JSON.stringify({ ok: true, stages }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exitCode = 1;
});
