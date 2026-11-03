import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, verify } from "node:crypto";
import {
  samlFixture,
  cookieJar,
  requestInfo,
  signedResponse,
  callbackRequest,
} from "./helpers/saml";
import { SamlAuth, samlCookie } from "../src/server/saml";
import { SamlCache } from "../src/server/saml-cache";
import { samlSettings } from "../src/server/saml-config";
import { sqliteStore } from "../src/server/store";
import { HttpError } from "../src/server/errors";
import { Sessions, sessionCookie } from "../src/server/sessions";
import { config } from "../src/server/config";
import { digest } from "../src/server/local-auth";

process.env.AUTH_MODE = "saml";
process.env.APP_ORIGIN = "https://copy.example.com";
process.env.STORAGE_DRIVER = "sqlite";
delete process.env.SAML_SECRETS_ARN;
const fixture = await samlFixture();
after(fixture.cleanup);
Object.assign(process.env, {
  SAML_ENTRY_POINT: fixture.settings.entryPoint,
  SAML_IDP_ISSUER: fixture.settings.idpIssuer,
  SAML_SP_ENTITY_ID: fixture.settings.entityId,
  SAML_IDP_CERT: fixture.idp.cert,
  SAML_SP_PRIVATE_KEY: fixture.sp.key,
  SAML_SP_CERT: fixture.sp.cert,
});
const denied = (error: unknown) =>
  error instanceof HttpError && error.status === 401;
async function start(store?: Awaited<ReturnType<typeof sqliteStore>>) {
  store ??= await sqliteStore(":memory:");
  const auth = new SamlAuth(store, fixture.settings);
  const jar = cookieJar();
  const url = await auth.begin(jar.cookies);
  const info = requestInfo(url);
  return { store, auth, jar, url, ...info };
}
test("SAML settings pin certificates, require matching signing keys, and fail closed outside HTTPS", async () => {
  assert.equal((await samlSettings()).idpCert[0], fixture.idp.cert.trim());
  const key = process.env.SAML_SP_PRIVATE_KEY;
  process.env.SAML_SP_PRIVATE_KEY = fixture.idp.key;
  await assert.rejects(samlSettings, /match/);
  process.env.SAML_SP_PRIVATE_KEY = key;
  const origin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "http://localhost:4321";
  assert.throws(config, /HTTPS/);
  process.env.APP_ORIGIN = origin;
  const entry = process.env.SAML_ENTRY_POINT;
  process.env.SAML_ENTRY_POINT =
    "https://idp.example.com/sso?RelayState=external";
  await assert.rejects(samlSettings, /protocol parameters/);
  process.env.SAML_ENTRY_POINT = entry;
});
test("SP-initiated login signs the redirect request and issues a short Secure/HttpOnly browser-binding cookie", async () => {
  const f = await start();
  const url = new URL(f.url);
  const signed = f.url.split("?")[1]!.split("&Signature=")[0]!;
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(signed),
      fixture.sp.cert,
      Buffer.from(url.searchParams.get("Signature")!, "base64"),
    ),
    true,
  );
  assert.match(f.xml, /nameid-format:persistent/);
  assert.match(f.id, /^_[a-f0-9]{48}$/);
  assert.equal(f.jar.options[samlCookie]?.secure, true);
  assert.equal(f.jar.options[samlCookie]?.httpOnly, true);
  assert.equal(f.jar.options[samlCookie]?.sameSite, "none");
  assert.equal(f.jar.options[samlCookie]?.path, "/auth/saml");
  assert.equal(f.jar.options[samlCookie]?.maxAge, 600);
  assert.equal(f.jar.values.get(samlCookie)?.length, 64);
  assert.notEqual(f.relay, f.jar.values.get(samlCookie));
  const metadata = f.auth.metadata();
  assert.match(metadata, /AuthnRequestsSigned="true"/);
  assert.match(metadata, /WantAssertionsSigned="true"/);
  assert.match(metadata, /https:\/\/copy.example.com\/auth\/saml\/acs/);
  assert.equal(metadata.includes("PRIVATE KEY"), false);
});
test("signed SAML login maps verified groups, scopes stable identities by issuer/subject, and uses revocable opaque sessions", async () => {
  const f = await start();
  const response = signedResponse(fixture, f.id, {
    groups: ["kieli-admin", "kieli:website:user", "kieli:website:manager"],
  });
  const result = await f.auth.finish(
    callbackRequest(response.encoded, f.relay),
    f.jar.cookies,
  );
  assert.equal(result.identity.admin, true);
  assert.equal(result.identity.projects.website, "manager");
  assert.equal(result.identity.provider, "saml");
  assert.equal(result.identity.issuer, fixture.settings.idpIssuer);
  assert.equal(result.identity.subject, "immutable-user-123");
  assert.equal(
    result.identity.sub,
    `saml:${digest(JSON.stringify([fixture.settings.idpIssuer, "immutable-user-123"]))}`,
  );
  assert.ok(result.maxAge > 1700 && result.maxAge <= 1800);
  assert.equal(f.jar.values.has(samlCookie), false);
  const sessions = new Sessions(f.store);
  await sessions.create(f.jar.cookies, result);
  const secret = f.jar.values.get(sessionCookie)!;
  assert.equal(secret.length, 64);
  assert.equal(
    (await sessions.resolve(f.jar.cookies))?.projects.website,
    "manager",
  );
  await sessions.revoke(f.jar.cookies);
  assert.equal(
    await sessions.resolve(cookieJar([[sessionCookie, secret]]).cookies),
    undefined,
  );
  const next = await start(f.store);
  const changedEmail = signedResponse(fixture, next.id, {
    email: "changed@example.com",
  });
  assert.equal(
    (
      await next.auth.finish(
        callbackRequest(changedEmail.encoded, next.relay),
        next.jar.cookies,
      )
    ).identity.sub,
    result.identity.sub,
  );
});
test("assertion and request replay are rejected atomically across concurrent service instances", async () => {
  const f = await start();
  const first = signedResponse(fixture, f.id);
  const snapshot = [...f.jar.values];
  const calls = await Promise.allSettled(
    [
      new SamlAuth(f.store, fixture.settings),
      new SamlAuth(f.store, fixture.settings),
    ].map((auth) =>
      auth.finish(
        callbackRequest(first.encoded, f.relay),
        cookieJar(snapshot).cookies,
      ),
    ),
  );
  assert.equal(calls.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    calls.filter((r) => r.status === "rejected" && denied(r.reason)).length,
    1,
  );
  await assert.rejects(
    f.auth.finish(
      callbackRequest(first.encoded, f.relay),
      cookieJar(snapshot).cookies,
    ),
    denied,
  );
  const second = await start(f.store);
  const reusedAssertionId = signedResponse(fixture, second.id, {
    assertionId: first.assertionId,
  });
  await assert.rejects(
    second.auth.finish(
      callbackRequest(reusedAssertionId.encoded, second.relay),
      second.jar.cookies,
    ),
    denied,
  );
});
test("SAML reauthentication revokes the prior session even though cross-site POST omits its Lax cookie", async () => {
  const store = await sqliteStore(":memory:");
  const sessions = new Sessions(store);
  const browser = cookieJar();
  await sessions.create(browser.cookies, {
    identity: {
      sub: "saml:previous",
      name: "Previous",
      email: "",
      admin: false,
      projects: {},
      provider: "saml",
    },
    maxAge: 3600,
  });
  const oldSession = browser.values.get(sessionCookie)!;
  const auth = new SamlAuth(store, fixture.settings);
  const flow = requestInfo(await auth.begin(browser.cookies));
  const callbackCookies = cookieJar([
    [samlCookie, browser.values.get(samlCookie)!],
  ]);
  const response = signedResponse(fixture, flow.id);
  const result = await auth.finish(
    callbackRequest(response.encoded, flow.relay),
    callbackCookies.cookies,
  );
  assert.equal(
    await sessions.resolve(cookieJar([[sessionCookie, oldSession]]).cookies),
    undefined,
  );
  await sessions.create(callbackCookies.cookies, result);
  assert.notEqual(callbackCookies.values.get(sessionCookie), oldSession);
  assert.equal(
    (await sessions.resolve(callbackCookies.cookies))?.provider,
    "saml",
  );
});
test("a response cannot be delivered to another browser or another outstanding login", async () => {
  const a = await start(),
    b = await start(a.store);
  const response = signedResponse(fixture, a.id);
  await assert.rejects(
    a.auth.finish(
      callbackRequest(response.encoded, a.relay),
      cookieJar().cookies,
    ),
    denied,
  );
  await assert.rejects(
    a.auth.finish(
      callbackRequest(response.encoded, a.relay),
      cookieJar([[samlCookie, randomBytes(32).toString("hex")]]).cookies,
    ),
    denied,
  );
  await assert.rejects(
    b.auth.finish(callbackRequest(response.encoded, b.relay), b.jar.cookies),
    denied,
  );
  const valid = await a.auth.finish(
    callbackRequest(response.encoded, a.relay),
    a.jar.cookies,
  );
  assert.equal(valid.identity.subject, "immutable-user-123");
});
test("an embedded certificate cannot replace the pinned IdP certificate", async () => {
  const f = await start();
  const untrusted = signedResponse({ ...fixture, idp: fixture.sp }, f.id);
  await assert.rejects(
    f.auth.finish(callbackRequest(untrusted.encoded, f.relay), f.jar.cookies),
    denied,
  );
});
test("hundreds of SAML assignments stay server-side and missing groups grant no access", async () => {
  const f = await start();
  const groups = Array.from(
    { length: 500 },
    (_, index) => `kieli:project-${index}:user`,
  );
  const response = signedResponse(fixture, f.id, { groups });
  const result = await f.auth.finish(
    callbackRequest(response.encoded, f.relay),
    f.jar.cookies,
  );
  assert.equal(Object.keys(result.identity.projects).length, 500);
  assert.equal(result.identity.admin, false);
  await new Sessions(f.store).create(f.jar.cookies, result);
  assert.equal(f.jar.values.get(sessionCookie)?.length, 64);
  const other = await start(f.store);
  const noGroups = signedResponse(fixture, other.id, { groups: [] });
  const none = await other.auth.finish(
    callbackRequest(noGroups.encoded, other.relay),
    other.jar.cookies,
  );
  assert.equal(none.identity.admin, false);
  assert.deepEqual(Object.keys(none.identity.projects), []);
});
test("expired browser flows are rejected before eventual database TTL cleanup", async () => {
  const store = await sqliteStore(":memory:");
  const expiredStore = {
    ...store,
    put: async (...args: Parameters<typeof store.put>) => {
      if (args[0].startsWith("SAML_FLOW#"))
        args[2] = { ...args[2], ttl: Math.floor(Date.now() / 1000) - 1 };
      await store.put(...args);
    },
  };
  const f = await start(expiredStore);
  const response = signedResponse(fixture, f.id);
  await assert.rejects(
    f.auth.finish(callbackRequest(response.encoded, f.relay), f.jar.cookies),
    denied,
  );
});
test("SAML cannot create a session or initiate sign-in when another authentication mode is selected", async () => {
  const f = await start();
  const response = signedResponse(fixture, f.id);
  const result = await f.auth.finish(
    callbackRequest(response.encoded, f.relay),
    f.jar.cookies,
  );
  process.env.AUTH_MODE = "local";
  try {
    await assert.rejects(
      f.auth.begin(cookieJar().cookies),
      (error: unknown) => error instanceof HttpError && error.status === 404,
    );
    await assert.rejects(
      new Sessions(f.store).create(f.jar.cookies, result),
      /provider does not match/,
    );
  } finally {
    process.env.AUTH_MODE = "saml";
  }
});
for (const [label, changes] of [
  ["tampered XML", { tamper: true }],
  ["unsigned response", { unsignedResponse: true }],
  ["unsigned assertion", { unsignedAssertion: true }],
  ["SHA-1 signatures", { sha1: true }],
  ["wrong response issuer", { responseIssuer: "https://other.example.com" }],
  ["wrong assertion issuer", { issuer: "https://other.example.com" }],
  ["wrong audience", { audience: "https://other.example.com" }],
  ["wrong destination", { destination: "https://other.example.com/acs" }],
  ["wrong recipient", { recipient: "https://other.example.com/acs" }],
  ["wrong subject correlation", { subjectRequestId: "_unknown" }],
  [
    "non-bearer subject",
    { confirmationMethod: "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key" },
  ],
  [
    "transient subject",
    { nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" },
  ],
  [
    "expired assertion",
    { expires: new Date(Date.now() - 120000).toISOString() },
  ],
  [
    "future assertion",
    { notBefore: new Date(Date.now() + 120000).toISOString() },
  ],
  ["old assertion", { issued: new Date(Date.now() - 600000).toISOString() }],
  [
    "expired IdP session",
    { sessionExpires: new Date(Date.now() - 1000).toISOString() },
  ],
] as const)
  test(`SAML rejects ${label}`, async () => {
    const f = await start();
    const response = signedResponse(fixture, f.id, changes);
    await assert.rejects(
      f.auth.finish(callbackRequest(response.encoded, f.relay), f.jar.cookies),
      denied,
    );
  });
test("forms are bounded and cannot smuggle duplicate fields or XML entities", async () => {
  const f = await start();
  const duplicate = callbackRequest("YQ==", f.relay);
  const text = await duplicate.text();
  await assert.rejects(
    f.auth.finish(
      new Request(duplicate.url, {
        method: "POST",
        headers: duplicate.headers,
        body: text + "&RelayState=other",
      }),
      f.jar.cookies,
    ),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    f.auth.finish(callbackRequest("A".repeat(270000), f.relay), f.jar.cookies),
    (error: unknown) => error instanceof HttpError && error.status === 413,
  );
  const response = signedResponse(fixture, f.id);
  const dtd = Buffer.from(
    '<!DOCTYPE samlp:Response [<!ENTITY data SYSTEM "file:///etc/passwd">]>' +
      response.xml,
  ).toString("base64");
  await assert.rejects(
    f.auth.finish(callbackRequest(dtd, f.relay), f.jar.cookies),
    denied,
  );
});
test("shared cache enforces atomic consumption, expiry, and provider boundaries", async () => {
  const store = await sqliteStore(":memory:");
  const a = new SamlCache(store, "idp-a"),
    b = new SamlCache(store, "idp-b");
  await a.saveAsync("request", "issued");
  assert.equal(await b.getAsync("request"), null);
  const consumed = await Promise.all([
    a.consumeAsync("request"),
    new SamlCache(store, "idp-a").consumeAsync("request"),
  ]);
  assert.equal(consumed.filter((v) => v === "issued").length, 1);
  assert.equal(
    await a.saveIfAbsentAsync("expired", "old", Date.now() - 1),
    true,
  );
  assert.equal(await a.getAsync("expired"), null);
  assert.equal(
    await a.saveIfAbsentAsync("expired", "new", Date.now() + 10000),
    true,
  );
  const inserts = await Promise.all(
    Array.from({ length: 10 }, () =>
      a.saveIfAbsentAsync("replay", "first", Date.now() + 10000),
    ),
  );
  assert.equal(inserts.filter(Boolean).length, 1);
});
