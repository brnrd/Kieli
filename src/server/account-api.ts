import type { APIContext } from "astro";
import { z } from "zod";
import { config } from "./config";
import { HttpError } from "./errors";
import { readJSON } from "./http";
import { localAuth } from "./local-auth";
import { sessions } from "./sessions";
import { installation } from "./installation";

export async function handleAccountApi(
  context: APIContext,
): Promise<Response | undefined> {
  const { request, params, locals, url, cookies } = context;
  const path = params.path ?? "";
  if (
    !path.startsWith("auth/") &&
    path !== "users" &&
    !path.startsWith("users/")
  )
    return undefined;
  if (config().authMode !== "local")
    throw new HttpError(404, "Built-in user management is not enabled.");
  const auth = await localAuth();
  const client = () => {
    try {
      return context.clientAddress || "unavailable";
    } catch {
      return "unavailable";
    }
  };
  if (path === "auth/install") {
    if (request.method !== "POST")
      throw new HttpError(405, "Use POST to complete installation.");
    const user = await (
      await installation()
    ).complete(await readJSON(request, 8192), client());
    await (await sessions()).create(cookies, { user });
    return Response.json({ ok: true });
  }
  if (path === "auth/login" && request.method === "POST") {
    const user = await auth.login(await readJSON(request, 8192), client());
    await (await sessions()).create(cookies, { user });
    return Response.json({ ok: true });
  }
  if (path === "auth/activate" && request.method === "POST") {
    const user = await auth.acceptLink(await readJSON(request, 8192), client());
    await (await sessions()).create(cookies, { user });
    return Response.json({ ok: true });
  }
  const identity = locals.identity;
  if (!identity) throw new HttpError(401, "Sign in to continue.");
  if (path === "auth/password" && request.method === "POST") {
    const user = await auth.changePassword(
      identity,
      await readJSON(request, 8192),
    );
    await (await sessions()).create(cookies, { user });
    return Response.json({ ok: true });
  }
  if (path === "users" && request.method === "GET") {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(1024).optional(),
        query: z.string().max(200).optional(),
      })
      .parse({
        limit: url.searchParams.get("limit") ?? 50,
        cursor: url.searchParams.get("cursor") ?? undefined,
        query: url.searchParams.get("q") ?? undefined,
      });
    return Response.json(await auth.list(identity, query));
  }
  if (path === "users" && request.method === "POST")
    return Response.json(await auth.invite(identity, await readJSON(request)), {
      status: 201,
    });
  if (path === "users/audit" && request.method === "GET")
    return Response.json(
      await auth.audit(
        identity,
        50,
        url.searchParams.get("cursor") ?? undefined,
      ),
    );
  const match = /^users\/([a-f0-9-]{36})(?:\/(link|revoke))?$/.exec(path);
  if (match) {
    if (!match[2] && request.method === "PATCH")
      return Response.json(
        await auth.updateUser(identity, match[1]!, await readJSON(request)),
      );
    if (match[2] && request.method === "POST") {
      const data = z
        .object({ version: z.number().int().positive() })
        .strict()
        .parse(await readJSON(request, 8192));
      return Response.json(
        match[2] === "link"
          ? await auth.setupLink(identity, match[1]!, data.version)
          : await auth.revokeSessions(identity, match[1]!, data.version),
      );
    }
  }
  throw new HttpError(404, "Endpoint not found.");
}
