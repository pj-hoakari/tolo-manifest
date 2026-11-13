const fakeidp = process.env.FAKEIDP_URL;
const ownerSub = process.env.TOLO_OWNER_SUB;
const ttlSeconds = Number(process.env.TOLO_TOKEN_TTL_SECONDS);

export async function eventAccessToken({ tenantId, eventId }) {
  const response = await fetch(`${fakeidp}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token_use: "event_access",
      sub: ownerSub,
      client_id: "console-ui",
      tenant_id: tenantId,
      event_id: eventId,
      scope: "events.read events.manage events.operate",
      ttl_seconds: ttlSeconds,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`token request failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}
