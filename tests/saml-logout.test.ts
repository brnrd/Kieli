import test, { after } from "node:test";
import assert from "node:assert/strict";
import { verify, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  samlFixture,
  cookieJar,
  signedLogout,
  requestInfo,
  signedResponse,
  callbackRequest,
} from "./helpers/saml";
import { SamlLogout, samlLogoutCookie } from "../src/server/saml-logout";
import { SamlAuth } from "../src/server/saml";
import { Sessions, sessionCookie } from "../src/server/sessions";
import { sqliteStore } from "../src/server/store";
import { HttpError } from "../src/server/errors";
import { samlSettings } from "../src/server/saml-config";
process.env.AUTH_MODE = "saml";
process.env.APP_ORIGIN = "https://copy.example.com";
const fixture = await samlFixture();
after(fixture.cleanup);
fixture.settings.logoutUrl = "https://idp.example.com/slo";
fixture.settings.logoutCallbackUrl =
  "https://copy.example.com/auth/saml/logout";
Object.assign(process.env, {
  SAML_ENTRY_POINT: fixture.settings.entryPoint,
  SAML_IDP_ISSUER: fixture.settings.idpIssuer,
  SAML_IDP_CERT: fixture.idp.cert,
  SAML_SP_PRIVATE_KEY: fixture.sp.key,
  SAML_SP_CERT: fixture.sp.cert,
  SAML_LOGOUT_URL: fixture.settings.logoutUrl,
});
delete process.env.SAML_SECRETS_ARN;
const denied = (error: unknown) =>
  error instanceof HttpError && error.status === 401;
async function setup() {
  const store = await sqliteStore(":memory:");
  return {
    store,
    sessions: new Sessions(store),
    logout: new SamlLogout(store, fixture.settings),
  };
}
async function login(f: Awaited<ReturnType<typeof setup>>, changes = {}) {
  const jar = cookieJar(),
    auth = new SamlAuth(f.store, fixture.settings);
  const info = requestInfo(await auth.begin(jar.cookies));
  const result = await auth.finish(
    callbackRequest(
      signedResponse(fixture, info.id, changes).encoded,
      info.relay,
    ),
    jar.cookies,
  );
  await f.sessions.create(jar.cookies, result);
  return { jar, result };
}
async function begin(f: Awaited<ReturnType<typeof setup>>) {
  // Separate app-initiated sign-ins model fresh IdP sessions, even within one millisecond.
  const user = await login(f, { sessionIndex: `test-session-${randomUUID()}` });
  const saved = user.jar.values.get(sessionCookie)!;
  const url = new URL(
    await f.logout.begin(
      await f.sessions.endForSamlLogout(user.jar.cookies),
      user.jar.cookies,
    ),
  );
  const xml = inflateRawSync(
    Buffer.from(url.searchParams.get("SAMLRequest")!, "base64"),
  ).toString();
  const id = /\bID="([^"]+)"/.exec(xml)![1]!;
  return {
    ...user,
    saved,
    url,
    xml,
    id,
    relay: url.searchParams.get("RelayState")!,
  };
}
test("SLO configuration is optional, HTTPS only, and metadata advertises the callback only when enabled", async () => {
  assert.equal((await samlSettings()).logoutUrl, fixture.settings.logoutUrl);
  const f = await setup();
  assert.match(
    new SamlAuth(f.store, fixture.settings).metadata(),
    /SingleLogoutService/,
  );
  const off = {
    ...fixture.settings,
    logoutUrl: undefined,
    logoutCallbackUrl: undefined,
  };
  assert.doesNotMatch(
    new SamlAuth(f.store, off).metadata(),
    /SingleLogoutService/,
  );
  await assert.rejects(
    new SamlLogout(f.store, off).begin(undefined, cookieJar().cookies),
    /not configured/,
  );
  for (const url of [
    "http://idp.example.com/slo",
    "https://x:secret@idp.example.com/slo",
    "https://idp.example.com/slo?RelayState=x",
    "https://idp.example.com/slo#fragment",
  ]) {
    process.env.SAML_LOGOUT_URL = url;
    await assert.rejects(samlSettings);
  }
  process.env.SAML_LOGOUT_URL = fixture.settings.logoutUrl;
});
test("SP logout revokes locally first, signs the correct subject/session and binds the verified response to its browser", async () => {
  const f = await setup(),
    flow = await begin(f);
  assert.equal(
    await f.sessions.resolve(cookieJar([[sessionCookie, flow.saved]]).cookies),
    undefined,
  );
  assert.match(flow.xml, /immutable-user-123/);
  assert.match(flow.xml, /test-session/);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(flow.url.search.slice(1).split("&Signature=")[0]!),
      fixture.sp.cert,
      Buffer.from(flow.url.searchParams.get("Signature")!, "base64"),
    ),
    true,
  );
  assert.equal(flow.jar.options[samlLogoutCookie]?.sameSite, "none");
  const response = signedLogout(fixture, {
    inResponseTo: flow.id,
    relay: flow.relay,
  });
  await assert.rejects(
    f.logout.receive(response.request.clone(), cookieJar().cookies),
    denied,
  );
  const result = await f.logout.receive(
    response.request.clone(),
    flow.jar.cookies,
  );
  assert.equal(result.location, "/login?logout=saml");
  await assert.rejects(
    f.logout.receive(response.request.clone(), flow.jar.cookies),
    denied,
  );
});
test("Redirect logout responses require a signed, unmodified RelayState and atomically consume pending flows", async () => {
  const f = await setup(),
    flow = await begin(f);
  const response = signedLogout(fixture, {
    inResponseTo: flow.id,
    relay: flow.relay,
    redirect: true,
  });
  const cookies = [...flow.jar.values];
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      f.logout.receive(response.request.clone(), cookieJar(cookies).cookies),
    ),
  );
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((value) => value.status === "rejected").length,
    1,
  );
});
test("verified IdP logout revokes only the named issuer/subject/session across browsers, without cookies", async () => {
  const f = await setup();
  const a = await login(f),
    b = await login(f),
    otherIndex = await login(f, { sessionIndex: "another-session" }),
    otherUser = await login(f, { subject: "someone-else" });
  const message = signedLogout(fixture, {
    request: true,
    relay: "opaque-state",
  });
  const result = await f.logout.receive(
    message.request.clone(),
    cookieJar().cookies,
  );
  const response = new URL(result.location);
  assert.equal(response.origin, "https://idp.example.com");
  assert.equal(response.searchParams.get("RelayState"), "opaque-state");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(response.search.slice(1).split("&Signature=")[0]!),
      fixture.sp.cert,
      Buffer.from(response.searchParams.get("Signature")!, "base64"),
    ),
    true,
  );
  assert.match(
    inflateRawSync(
      Buffer.from(response.searchParams.get("SAMLResponse")!, "base64"),
    ).toString(),
    new RegExp(`InResponseTo="${message.id}"`),
  );
  assert.equal(await f.sessions.resolve(a.jar.cookies), undefined);
  assert.equal(await f.sessions.resolve(b.jar.cookies), undefined);
  assert.ok(await f.sessions.resolve(otherIndex.jar.cookies));
  assert.ok(await f.sessions.resolve(otherUser.jar.cookies));
  await assert.rejects(
    f.logout.receive(message.request.clone(), cookieJar().cookies),
    denied,
  );
});
test("IdP Redirect logout supports all subject sessions when indexes are absent and rejects concurrent replay", async () => {
  const f = await setup(),
    a = await login(f),
    b = await login(f, { sessionIndex: "another-session" });
  const message = signedLogout(fixture, {
    request: true,
    indexes: [],
    redirect: true,
  });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      f.logout.receive(message.request.clone(), cookieJar().cookies),
    ),
  );
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(await f.sessions.resolve(a.jar.cookies), undefined);
  assert.equal(await f.sessions.resolve(b.jar.cookies), undefined);
});
test("revocation fences session creation and concurrent session touches cannot resurrect access", async () => {
  const f = await setup(),
    a = await login(f);
  const snapshot = cookieJar([...a.jar.values]);
  await f.logout.receive(
    signedLogout(fixture, { request: true }).request,
    cookieJar().cookies,
  );
  await assert.rejects(
    f.sessions.create(cookieJar().cookies, a.result),
    denied,
  );
  assert.equal(await f.sessions.resolve(snapshot.cookies), undefined);
  // A new IdP session is still allowed; no principal/email-level block is created.
  assert.ok(
    await f.sessions.resolve(
      (await login(f, { sessionIndex: "new-session" })).jar.cookies,
    ),
  );
});
for (const redirect of [false, true])
  for (const [label, changes] of [
    ["unsigned", { unsigned: true }],
    ["weak signature", { sha1: true }],
    ["wrong destination", { destination: "https://other.example.com/logout" }],
    ["wrong issuer", { issuer: "https://other.example.com" }],
    [
      "expired issue time",
      { issued: new Date(Date.now() - 600000).toISOString() },
    ],
    [
      "future issue time",
      { issued: new Date(Date.now() + 120000).toISOString() },
    ],
    ["wrong qualifier", { nameQualifier: "https://other.example.com" }],
  ] as const)
    test(`IdP ${redirect ? "Redirect" : "POST"} rejects ${label} without revoking a session`, async () => {
      const f = await setup(),
        a = await login(f);
      await assert.rejects(
        f.logout.receive(
          signedLogout(fixture, { request: true, redirect, ...changes })
            .request,
          cookieJar().cookies,
        ),
        denied,
      );
      assert.ok(await f.sessions.resolve(a.jar.cookies));
    });
test("failed, tampered, untrusted and cross-flow responses never confirm provider logout", async () => {
  const f = await setup(),
    a = await begin(f),
    b = await begin(f);
  for (const changes of [
    { inResponseTo: b.id },
    { status: "PartialLogout" },
    { unsigned: true },
    { issuer: "https://other.example.com" },
  ]) {
    await assert.rejects(
      f.logout.receive(
        signedLogout(fixture, {
          inResponseTo: a.id,
          relay: a.relay,
          ...changes,
        }).request,
        a.jar.cookies,
      ),
      denied,
    );
  }
  await assert.rejects(
    f.logout.receive(
      signedLogout(
        { ...fixture, idp: fixture.sp },
        { inResponseTo: a.id, relay: a.relay },
      ).request,
      a.jar.cookies,
    ),
    denied,
  );
  const changed = signedLogout(fixture, { request: true });
  const body = new URLSearchParams(changed.raw);
  body.set(
    "SAMLRequest",
    Buffer.from(
      changed.xml.replace("immutable-user-123", "victim-user"),
    ).toString("base64"),
  );
  await assert.rejects(
    f.logout.receive(
      new Request(changed.request.url, {
        method: "POST",
        headers: changed.request.headers,
        body,
      }),
      cookieJar().cookies,
    ),
    denied,
  );
});
test("logout messages reject duplicate fields, XML entities, oversize expansion and too many indexes", async () => {
  const f = await setup();
  const message = signedLogout(fixture, { request: true, redirect: true });
  await assert.rejects(
    f.logout.receive(
      new Request(`${message.request.url}&SAMLResponse=YQ%3D%3D`),
      cookieJar().cookies,
    ),
    denied,
  );
  await assert.rejects(
    f.logout.receive(
      signedLogout(fixture, {
        request: true,
        indexes: Array.from({ length: 21 }, (_, i) => `index-${i}`),
      }).request,
      cookieJar().cookies,
    ),
    denied,
  );
  const xml =
    '<!DOCTYPE test [<!ENTITY entity SYSTEM "file:///never-read">]>' +
    message.xml;
  const fields = new URLSearchParams({
    SAMLRequest: Buffer.from(xml).toString("base64"),
  });
  await assert.rejects(
    f.logout.receive(
      new Request(fixture.settings.logoutCallbackUrl!, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: fields,
      }),
      cookieJar().cookies,
    ),
    denied,
  );
});

test("an IdP logout that commits between session validation and insertion fences the newly written session", async () => {
  const f = await setup(),
    a = await login(f);
  let release!: () => void, reached!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const delayed = {
    ...f.store,
    put: async (...args: Parameters<typeof f.store.put>) => {
      if (args[0].startsWith("SESSION#")) {
        reached();
        await pause;
      }
      return f.store.put(...args);
    },
  };
  const jar = cookieJar();
  const creating = new Sessions(delayed).create(jar.cookies, a.result);
  await waiting;
  await f.logout.receive(
    signedLogout(fixture, { request: true }).request,
    cookieJar().cookies,
  );
  release();
  await creating;
  assert.ok(jar.values.has(sessionCookie));
  assert.equal(await f.sessions.resolve(jar.cookies), undefined);
});

test("expired logout flows and compressed expansion cannot bypass validation", async () => {
  const f = await setup(),
    flow = await begin(f);
  const expired = {
    ...f.store,
    get: async <T>(pk: string, sk: string): Promise<T | undefined> => {
      const value = await f.store.get<T>(pk, sk);
      return pk.startsWith("SAML_LOGOUT_FLOW#") && value
        ? { ...value, ttl: 0 }
        : value;
    },
  };
  await assert.rejects(
    new SamlLogout(expired, fixture.settings).receive(
      signedLogout(fixture, { inResponseTo: flow.id, relay: flow.relay })
        .request,
      flow.jar.cookies,
    ),
    denied,
  );
  const { deflateRawSync } = await import("node:zlib");
  const query = new URLSearchParams({
    SAMLRequest: deflateRawSync(" ".repeat(300000)).toString("base64"),
    SigAlg: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    Signature: "YQ==",
  });
  await assert.rejects(
    f.logout.receive(
      new Request(`${fixture.settings.logoutCallbackUrl}?${query}`),
      cookieJar().cookies,
    ),
    denied,
  );
});

test("multiple session indexes revoke together, preserve other subjects, and audit without protocol payloads", async () => {
  const f = await setup(),
    a = await login(f),
    b = await login(f, { sessionIndex: "second-index" }),
    other = await login(f, { subject: "another-person" });
  await f.logout.receive(
    signedLogout(fixture, {
      request: true,
      indexes: ["test-session", "second-index"],
    }).request,
    cookieJar().cookies,
  );
  assert.equal(await f.sessions.resolve(a.jar.cookies), undefined);
  assert.equal(await f.sessions.resolve(b.jar.cookies), undefined);
  assert.ok(await f.sessions.resolve(other.jar.cookies));
  const audit = JSON.stringify(await f.store.list("AUTH_AUDIT", ""));
  assert.match(audit, /logout.saml_idp_revoked/);
  assert.doesNotMatch(
    audit,
    /immutable-user-123|second-index|SAMLRequest|PRIVATE KEY|Alex Morgan/,
  );
});

test("enabling SLO requires legacy sessions to sign in again; disabling SLO does not undo existing fences", async () => {
  const f = await setup(),
    a = await login(f);
  const { digest } = await import("../src/server/local-auth");
  const pk = `SESSION#${digest(a.jar.values.get(sessionCookie)!)}`;
  const row = await f.store.get<{
    version: number;
    saml?: unknown;
    [key: string]: unknown;
  }>(pk, "META");
  const { saml: _context, ...legacy } = row!;
  await f.store.put(
    pk,
    "META",
    { ...legacy, version: legacy.version + 1 },
    legacy.version,
  );
  assert.equal(
    await f.sessions.resolve(cookieJar([...a.jar.values]).cookies),
    undefined,
  );
  process.env.SAML_LOGOUT_URL = "";
  try {
    assert.ok(await f.sessions.resolve(a.jar.cookies));
  } finally {
    process.env.SAML_LOGOUT_URL = fixture.settings.logoutUrl;
  }
  const b = await login(f);
  await f.logout.receive(
    signedLogout(fixture, { request: true }).request,
    cookieJar().cookies,
  );
  process.env.SAML_LOGOUT_URL = "";
  try {
    assert.equal(await f.sessions.resolve(b.jar.cookies), undefined);
  } finally {
    process.env.SAML_LOGOUT_URL = fixture.settings.logoutUrl;
  }
});
