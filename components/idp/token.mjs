import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const idp = process.env.IDP_URL;
const webOrigin = process.env.WEB_ORIGIN;
const clientId = process.env.IDP_CLIENT_ID;
const clientSecret = process.env.IDP_CLIENT_SECRET;
const redirectUri = process.env.IDP_REDIRECT_URI;
const audience = process.env.IDP_AUDIENCE;
const resourceHost = process.env.IDP_RESOURCE_HOST;
const ownerSub = process.env.TOLO_OWNER_SUB;
const usersFile = process.env.IDP_SEED_USERS_FILE;

const scope = "events.read events.manage events.operate";
const cookies = new Map();
const b64url = (buffer) => buffer.toString("base64url");

async function request(path, init = {}) {
  const response = await fetch(new URL(path, idp), {
    ...init,
    redirect: "manual",
    headers: {
      ...init.headers,
      Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return response;
}

function param(response, name) {
  const location = response.headers.get("location");
  const value = location && new URL(location, idp).searchParams.get(name);
  if (!value) throw new Error(`no ${name} in the redirect: ${response.status} ${location}`);
  return value;
}

async function token(params) {
  const response = await fetch(new URL("/oauth2/token", idp), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(params),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`token request failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

export async function eventAccessToken({ tenantId, eventId }) {
  const { users } = JSON.parse(await readFile(usersFile, "utf8"));
  const owner = users.find((user) => user.id === ownerSub);
  if (!owner) throw new Error(`no seed user with the id ${ownerSub}`);

  const tenantResource = `https://${resourceHost}/tenants/${tenantId}`;
  const verifier = b64url(randomBytes(32));
  const challenge = param(
    await request(
      `/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: `openid ${scope}`,
        state: b64url(randomBytes(16)),
        nonce: b64url(randomBytes(16)),
        audience,
        resource: tenantResource,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      })}`,
    ),
    "challenge",
  );

  const login = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: webOrigin },
    body: JSON.stringify({ username: owner.username, password: owner.password, challenge }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);

  const code = param(
    await request(`/oauth2/authorize?${new URLSearchParams({ challenge })}`),
    "code",
  );

  const tenantAccess = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  return token({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: tenantAccess,
    audience,
    resource: `${tenantResource}/events/${eventId}`,
    scope,
  });
}
