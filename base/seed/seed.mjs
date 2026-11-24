import { readFile } from "node:fs/promises";
import { eventAccessToken } from "./token.mjs";

const gateway = process.env.GATEWAY_URL;
const tenantId = process.env.TOLO_TENANT_ID;
const eventId = process.env.TOLO_EVENT_ID;

const GRAPH = "tolo.graph.v1.GraphAuthoringService";
const GUEST_SETTINGS = "tolo.guest.v1.GuestSettingsService";
const EDGE_DEVICES = "tolo.observation.v1.EdgeDeviceService";
const STAFF_MESSAGES = "tolo.operation.v1.StaffCommunicationService";

const token = await eventAccessToken({ tenantId, eventId });

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

const listEdgeDevices = async () =>
  (await call(EDGE_DEVICES, "ListEdgeDevices", { eventId, includeUnregistered: true })).devices ?? [];

async function addMissing(items, existing, keyOf, add) {
  const present = new Set(existing.map(keyOf));
  const missing = items.filter((item) => !present.has(keyOf(item)));
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
    return addMissing(await fixture("qr-locations.json"), qrLocations, (q) => q.name, (qrLocation) =>
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
    return addMissing(
      await fixture("edge-devices.json"),
      await listEdgeDevices(),
      (d) => d.name,
      ({ observationPoints, ...device }) => call(EDGE_DEVICES, "RegisterEdgeDevice", { eventId, ...device }),
    );
  },
  async "observation points"() {
    const devices = new Map((await listEdgeDevices()).map((device) => [device.name, device]));
    const wanted = (await fixture("edge-devices.json")).flatMap(({ name, observationPoints }) => {
      const device = devices.get(name);
      return device.unregistered ? [] : observationPoints.map((point) => ({ device, name: point }));
    });
    const present = [...devices.values()].flatMap((device) =>
      (device.observationPoints ?? []).map(({ name }) => ({ device, name })),
    );
    return addMissing(wanted, present, (p) => `${p.device.edgeDeviceId}/${p.name}`, ({ device, name }) =>
      call(EDGE_DEVICES, "AddObservationPoint", { eventId, edgeDeviceId: device.edgeDeviceId, name }).catch(
        (error) => {
          if (error.code !== "already_exists") throw error;
        },
      ),
    );
  },
  async "guest messages"() {
    const audience = "AUDIENCE_GUEST";
    const { messages = [] } = await call(STAFF_MESSAGES, "ListStaffMessages", {
      eventId,
      tenantId,
      audience,
    });
    return addMissing(await fixture("guest-messages.json"), messages, (m) => m.body, (message) =>
      call(STAFF_MESSAGES, "SendStaffMessage", { eventId, tenantId, audience, ...message }),
    );
  },
  async publish() {
    await call(GRAPH, "PublishRevision", { eventId });
    return "created";
  },
};

const nodeIds = (document) => (document?.nodes ?? []).map((node) => node.nodeId).sort().join();
const graph = await getGraph();
const reason = graph?.meta?.revisionId
  ? "the event is already published"
  : graph && nodeIds(graph.document) !== nodeIds(await fixture("graph.json"))
    ? "the event has a graph that the seed did not make"
    : undefined;

if (reason) {
  console.log(`${reason}: skipped`);
} else {
  for (const [name, step] of Object.entries(steps)) {
    console.log(`${name}: ${await step()}`);
  }
}
