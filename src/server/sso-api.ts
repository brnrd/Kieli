import type { APIContext } from "astro";
import { z } from "zod";
import { config } from "./config";
import { getStore } from "./store";
import { HttpError } from "./errors";
import { SsoDirectory, ssoAudit } from "./sso-directory";
import { LocalAuth } from "./local-auth";
import { sessions } from "./sessions";
import { readJSON } from "./http";
export async function handleSsoApi(
  context: APIContext,
): Promise<Response | undefined> {
  const path = context.params.path ?? "";
  if (
    path !== "auth/revoke-all" &&
    path !== "sso/users" &&
    !path.startsWith("sso/users/")
  )
    return undefined;
  const { identity } = context.locals;
  if (!identity || identity.mcp || identity.tokenProject)
    throw new HttpError(401, "Sign in to manage account access.");
  const store = await getStore(),
    mode = config().authMode;
  if (path === "auth/revoke-all" && context.request.method === "POST") {
    if (mode === "local") {
      const auth = new LocalAuth(store),
        user = identity.sub.startsWith("local:")
          ? await auth.getUser(identity.sub.slice(6))
          : undefined;
      if (!user || user.status !== "active")
        throw new HttpError(401, "Active account required.");
      await store.transact([
        {
          pk: "USERS",
          sk: `USER#${user.id}`,
          value: {
            ...user,
            version: user.version + 1,
            authVersion: user.authVersion + 1,
            updatedAt: new Date().toISOString(),
          },
          expectedVersion: user.version,
        },
        ssoAudit("auth.all_access_revoked", identity.sub),
      ]);
    } else if (mode === "okta" || mode === "saml")
      await new SsoDirectory(store).revokeSelf(identity);
    else
      throw new HttpError(
        400,
        "Access revocation is unavailable in demo mode.",
      );
    await (await sessions()).revoke(context.cookies);
    return Response.json({ ok: true });
  }
  if (mode !== "okta" && mode !== "saml")
    throw new HttpError(404, "SSO user management is not enabled.");
  const directory = new SsoDirectory(store);
  await directory.requireAdmin(identity);
  if (path === "sso/users" && context.request.method === "GET") {
    const limit = Number(context.url.searchParams.get("limit") ?? 50),
      after = context.url.searchParams.get("after") ?? "",
      query = (context.url.searchParams.get("q") ?? "").toLowerCase();
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      query.length > 200 ||
      (!/^[a-f0-9]{64}$/.test(after) && after !== "")
    )
      throw new HttpError(400, "Invalid directory pagination.");
    const all = (await directory.allUsers())
      .filter(
        (user) =>
          user.id > after &&
          (!query ||
            `${user.name} ${user.email} ${user.userName}`
              .toLowerCase()
              .includes(query)),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    return Response.json({
      items: all
        .slice(0, limit)
        .map(
          ({
            id,
            name,
            email,
            userName,
            active,
            blocked,
            managed,
            version,
          }) => ({
            id,
            name,
            email,
            userName,
            active,
            blocked,
            managed,
            version,
          }),
        ),
      next: all.length > limit ? all[limit - 1]!.id : undefined,
      mode: directory.scope.mode,
      reconciliationConfigured: !!(
        process.env.SSO_RECONCILE_SECRET_ARN || process.env.SSO_OKTA_API_TOKEN
      ),
      reconciliation: await store.get(directory.scope.pk, "RECONCILE"),
    });
  }
  const match = /^sso\/users\/([a-f0-9]{64})$/.exec(path);
  if (match && context.request.method === "PATCH") {
    const input = z
      .object({
        version: z.number().int().positive(),
        action: z.enum(["block", "unblock", "revoke", "reactivate"]),
      })
      .strict()
      .parse(await readJSON(context.request, 8192));
    await directory.manage(identity, match[1]!, input.version, input.action);
    return Response.json({ ok: true });
  }
  throw new HttpError(404, "Endpoint not found.");
}
