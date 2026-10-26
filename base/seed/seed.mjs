import { readFile } from "node:fs/promises";

const gateway = process.env.GATEWAY_URL;
const fakeidp = process.env.FAKEIDP_URL;
const tenantId = process.env.TOLO_TENANT_ID;
const eventId = process.env.TOLO_EVENT_ID;
const ownerSub = process.env.TOLO_OWNER_SUB;
const ttlSeconds = Number(process.env.TOLO_TOKEN_TTL_SECONDS);

const GRAPH = "tolo.graph.v1.GraphAuthoringService";
const GUEST_SETTINGS = "tolo.guest.v1.GuestSettingsService";
const EDGE_DEVICES = "tolo.observation.v1.EdgeDeviceService";
const STAFF_MESSAGES = "tolo.operation.v1.StaffCommunicationService";

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

const token = await issue({
  token_use: "event_access",
  sub: ownerSub,
  client_id: "console-ui",
  tenant_id: tenantId,
  event_id: eventId,
  scope: "events.read events.manage events.operate",
});

async function call(service, method, request) {
  const response = await fetch(`${gateway}/${service}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${service}/${method} failed: ${response.status} ${text}`);
    error.code = JSON.parse(text || "{}").code;
    throw error;
  }
  return JSON.parse(text || "{}");
}

const fixture = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));

const getGraph = () =>
  call(GRAPH, "GetGraph", { eventId }).catch((error) => {
    if (error.code === "not_found") return undefined;
    throw error;
  });

async function addMissing(fixtureName, existing, keyOf, add) {
  const present = new Set(existing.map(keyOf));
  const missing = (await fixture(fixtureName)).filter((item) => !present.has(keyOf(item)));
  for (const item of missing) await add(item);
  return missing.length ? `created ${missing.length}` : "skipped";
}

const steps = {
  async graph() {
    if (await getGraph()) return "skipped";
    await call(GRAPH, "SaveGraph", { eventId, document: await fixture("graph.json") });
    return "created";
  },
  async "guide map layout"() {
    if ((await getGraph()).guideMapLayout) return "skipped";
    await call(GRAPH, "SaveGuideMapLayout", {
      eventId,
      guideMapLayout: await fixture("guide-map-layout.json"),
    });
    return "created";
  },
  async "QR locations"() {
    const { qrLocations = [] } = await getGraph();
    return addMissing("qr-locations.json", qrLocations, (q) => q.name, (qrLocation) =>
      call(GRAPH, "AddQrLocation", { eventId, qrLocation }),
    );
  },
  async "guest settings"() {
    await call(GUEST_SETTINGS, "UpdateGuestSettings", {
      eventId,
      pageCompositions: await fixture("guest-settings.json"),
    });
    return "created";
  },
  async "edge devices"() {
    const { devices = [] } = await call(EDGE_DEVICES, "ListEdgeDevices", {
      eventId,
      includeUnregistered: true,
    });
    return addMissing("edge-devices.json", devices, (d) => d.name, (device) =>
      call(EDGE_DEVICES, "RegisterEdgeDevice", { eventId, ...device }),
    );
  },
  async "guest messages"() {
    const audience = "AUDIENCE_GUEST";
    const { messages = [] } = await call(STAFF_MESSAGES, "ListStaffMessages", {
      eventId,
      tenantId,
      audience,
    });
    return addMissing("guest-messages.json", messages, (m) => m.body, (message) =>
      call(STAFF_MESSAGES, "SendStaffMessage", { eventId, tenantId, audience, ...message }),
    );
  },
  async publish() {
    await call(GRAPH, "PublishRevision", { eventId });
    return "created";
  },
};

if ((await getGraph())?.meta?.revisionId) {
  console.log("the event is already published: skipped");
} else {
  for (const [name, step] of Object.entries(steps)) {
    console.log(`${name}: ${await step()}`);
  }
}
