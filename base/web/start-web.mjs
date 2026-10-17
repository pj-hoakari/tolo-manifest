const fakeidp = process.env.FAKEIDP_URL;
const tenantId = process.env.TOLO_TENANT_ID;
const eventId = process.env.TOLO_EVENT_ID;
const ownerSub = process.env.TOLO_OWNER_SUB;
const ttlSeconds = Number(process.env.TOLO_TOKEN_TTL_SECONDS);

async function issue(request) {
  const response = await fetch(`${fakeidp}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, ttl_seconds: ttlSeconds }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`token request failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

process.env.TENANT_ACCESS_TOKEN = await issue({
  token_use: "tenant_access",
  sub: ownerSub,
  client_id: "client-123",
  tenant_id: tenantId,
  scope: "tenant.read tenant.write events.read events.manage",
});
process.env.GRAPH_ACCESS_TOKEN = await issue({
  token_use: "event_access",
  sub: ownerSub,
  client_id: "console-ui",
  tenant_id: tenantId,
  event_id: eventId,
  scope: "events.read events.manage events.operate",
});
process.env.OBSERVATION_ACCESS_TOKEN = await issue({
  token_use: "event_access",
  sub: "dev-edge",
  client_id: "edge-page",
  tenant_id: tenantId,
  event_id: eventId,
  scope: "events.read events.report",
});

await import("/app/server.js");
