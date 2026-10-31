import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  samlFixture,
  requestInfo,
  signedResponse,
} from "../tests/helpers/saml.ts";

// The IdP is a local signing fixture; no real identity provider or user data is used.
const scimMode = process.argv.includes("--scim");
const fixture = await samlFixture();
const directory = await mkdtemp(join(tmpdir(), "keylo-saml-http-"));
const origin = "http://127.0.0.1:4328";
const env = {
  ...process.env,
  NODE_ENV: "production",
  AUTH_MODE: "saml",
  APP_ORIGIN: "https://copy.example.com",
  HOST: "127.0.0.1",
  PORT: "4328",
  STORAGE_DRIVER: "sqlite",
  SQLITE_PATH: join(directory, "data.sqlite"),
  SAML_ENTRY_POINT: fixture.settings.entryPoint,
  SAML_IDP_ISSUER: fixture.settings.idpIssuer,
  SAML_SP_ENTITY_ID: fixture.settings.entityId,
  SAML_IDP_CERT: fixture.idp.cert,
  SAML_SP_PRIVATE_KEY: fixture.sp.key,
  SAML_SP_CERT: fixture.sp.cert,
  SSO_PROVISIONING_MODE: scimMode ? "scim" : "jit",
  SSO_SCIM_TOKEN: "s".repeat(64),
};
delete env.SAML_SECRETS_ARN;
const server = spawn(process.execPath, ["dist/server/entry.mjs"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (data) => {
  logs += data;
});
server.stderr.on("data", (data) => {
  logs += data;
});
function request(path, options = {}) {
  return fetch(`${origin}${path}`, { redirect: "manual", ...options });
}
function session(response, name) {
  const value = response.headers
    .getSetCookie()
    .find(
      (cookie) =>
        cookie.startsWith(`${name}=`) && !cookie.startsWith(`${name}=;`),
    );
  assert.ok(value, `Expected ${name} cookie`);
  assert.match(value, /Secure/i);
  assert.match(value, /HttpOnly/i);
  return value.split(";")[0];
}
async function begin() {
  const response = await request("/auth/login");
  assert.equal(response.status, 302, await response.clone().text());
  const binding = session(response, "__Secure-keylo_saml");
  assert.match(
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-keylo_saml=")),
    /SameSite=None/i,
  );
  return { ...requestInfo(response.headers.get("location")), binding };
}
function post(encoded, flow, cookie = flow.binding) {
  return request("/auth/saml/acs", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://idp.example.com",
      Cookie: cookie,
    },
    body: new URLSearchParams({
      SAMLResponse: encoded,
      RelayState: flow.relay,
    }),
  });
}
async function provisioning(
  path,
  method = "GET",
  body,
  token = env.SSO_SCIM_TOKEN,
) {
  const response = await request(`/scim/v2/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/scim+json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}
async function browserApi(path, method, cookie, body) {
  return request(path, {
    method,
    headers: {
      Origin: env.APP_ORIGIN,
      Cookie: cookie,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
try {
  let provisioned;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw Error(`Server exited: ${logs}`);
    try {
      ready = (await request("/api/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  assert.equal((await request("/api/bootstrap")).status, 401);
  assert.match(
    await (await request("/login")).text(),
    /Continue with SAML SSO/,
  );
  const metadata = await request("/auth/saml/metadata");
  assert.equal(metadata.status, 200);
  assert.match(
    metadata.headers.get("content-type"),
    /application\/samlmetadata\+xml/,
  );
  assert.match(await metadata.text(), /AuthnRequestsSigned="true"/);
  if (scimMode) {
    assert.equal(
      (await provisioning("Users", "GET", undefined, "wrong")).status,
      401,
    );
    const user = await provisioning("Users", "POST", {
      externalId: "immutable-user-123",
      userName: "saml@example.com",
      active: true,
    });
    assert.equal(user.status, 201, await user.clone().text());
    provisioned = await user.json();
    const group = await provisioning("Groups", "POST", {
      displayName: "keylo-admin",
      members: [{ value: provisioned.id }],
    });
    assert.equal(group.status, 201, await group.clone().text());
  }
  const flow = await begin();
  const signed = signedResponse(fixture, flow.id, { groups: ["keylo-admin"] });
  // A foreign-origin POST is allowed only at ACS and only with complete protocol validation.
  assert.equal(
    (await post(signed.encoded, flow, "")).headers.get("location"),
    "/login?error=signin",
  );
  assert.equal(
    (
      await request("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://idp.example.com",
        },
        body: "name=blocked",
      })
    ).status,
    403,
  );
  const accepted = await post(signed.encoded, flow);
  assert.equal(accepted.status, 303, await accepted.clone().text());
  assert.equal(accepted.headers.get("location"), "/");
  const cookie = session(accepted, "keylo_session");
  assert.match(cookie, /^keylo_session=[a-f0-9]{64}$/);
  const bootstrap = await request("/api/bootstrap", {
    headers: { Cookie: cookie },
  });
  assert.equal(bootstrap.status, 200);
  const workspace = await bootstrap.json();
  assert.equal(workspace.authMode, "saml");
  assert.equal(workspace.identity.provider, "saml");
  assert.equal(workspace.identity.admin, true);
  assert.equal(
    (await post(signed.encoded, flow)).headers.get("location"),
    "/login?error=signin",
  );
  const invalid = await begin();
  const bad = signedResponse(fixture, invalid.id, {
    recipient: "https://attacker.example.com/acs",
  });
  const rejected = await post(bad.encoded, invalid);
  assert.equal(rejected.headers.get("location"), "/login?error=signin");
  assert.equal(
    rejected.headers
      .getSetCookie()
      .some((value) => /^keylo_session=[a-f0-9]{64}/.test(value)),
    false,
  );
  const signOut = await request("/auth/logout", {
    method: "POST",
    headers: { Origin: env.APP_ORIGIN, Cookie: cookie },
  });
  assert.equal(signOut.status, 302);
  assert.equal(
    (await request("/api/bootstrap", { headers: { Cookie: cookie } })).status,
    401,
  );
  if (scimMode) {
    // Reauthenticate after normal logout, then revoke every personal connection.
    const again = await begin();
    const acceptedAgain = await post(
      signedResponse(fixture, again.id, { groups: [] }).encoded,
      again,
    );
    const activeCookie = session(acceptedAgain, "keylo_session");
    const people = await browserApi("/api/sso/users", "GET", activeCookie);
    assert.equal(people.status, 200, await people.clone().text());
    assert.equal((await people.json()).items[0].id, provisioned.id);
    const page = await request("/users", { headers: { Cookie: activeCookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /People &amp; access/);
    assert.equal(
      (await browserApi("/api/auth/revoke-all", "POST", activeCookie)).status,
      200,
    );
    assert.equal(
      (await browserApi("/api/bootstrap", "GET", activeCookie)).status,
      401,
    );
    const deactivated = await provisioning(`Users/${provisioned.id}`, "PATCH", {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    assert.equal(deactivated.status, 200, await deactivated.clone().text());
    const final = await begin();
    assert.equal(
      (
        await post(
          signedResponse(fixture, final.id, { groups: ["keylo-admin"] })
            .encoded,
          final,
        )
      ).headers.get("location"),
      "/login?error=signin",
    );
    console.log(
      "SSO lifecycle HTTP smoke passed: separate SCIM authentication, provisioning, pushed groups, SAML sign-in, admin directory, account-wide revocation and deactivation blocking future login.",
    );
  }
  console.log(
    "SAML HTTP smoke passed: signed metadata/request, cross-site POST callback, browser binding, opaque sessions, roles, replay rejection, recipient validation, origin protection, and logout replay.",
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await fixture.cleanup();
  await rm(directory, { recursive: true, force: true });
}
