import { ZodError } from "zod";
import { config } from "./config";
import { HttpError } from "./errors";
import { Conflict, getStore, type Store } from "./store";
import { SyncCredentials } from "./sync-credentials";
import { KeyloService } from "./service";
import { readJSON } from "./http";
export async function handleSync(request: Request, store?: Store) {
  try {
    const expected = new URL(config().origin),
      host = request.headers.get("host"),
      origin = request.headers.get("origin");
    const hosts = [expected.host],
      origins = [expected.origin];
    if (
      config().authMode === "demo" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname)
    )
      for (const alias of ["localhost", "127.0.0.1", "[::1]"]) {
        const local = new URL(expected);
        local.hostname = alias;
        hosts.push(local.host);
        origins.push(local.origin);
      }
    if (
      !host ||
      !hosts.includes(host) ||
      (origin !== null && !origins.includes(origin))
    )
      throw new HttpError(403, "Invalid source-sync host or origin.");
    const storage = store ?? (await getStore()),
      identity = await new SyncCredentials(storage).authenticate(request);
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const parts = new URL(request.url).pathname.split("/").filter(Boolean),
      project = parts[1];
    if (parts[0] !== "sync" || project !== identity.sync.projectId)
      throw new HttpError(403, "Credential is scoped to another project.");
    const svc = new KeyloService(storage);
    if (parts.length === 3 && parts[2] === "preview")
      return Response.json(
        await svc.previewUpdate(identity, project, {
          ...((await readJSON(request)) as object),
          policy: "source",
        }),
      );
    if (parts.length === 4 && parts[2] === "apply") {
      await readJSON(request, 1024);
      return Response.json(await svc.applyUpdate(identity, project, parts[3]!));
    }
    throw new HttpError(404, "Source-sync endpoint not found.");
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof HttpError || error instanceof Conflict
            ? error.message
            : error instanceof ZodError
              ? "Invalid source-sync input."
              : "Source synchronization failed.",
      },
      {
        status:
          error instanceof HttpError
            ? error.status
            : error instanceof Conflict
              ? 409
              : error instanceof ZodError
                ? 400
                : 500,
        headers: {
          ...(error instanceof HttpError && error.status === 401
            ? { "WWW-Authenticate": 'Bearer realm="keylo-sync"' }
            : {}),
          ...(error instanceof HttpError && error.status === 429
            ? { "Retry-After": "60" }
            : {}),
        },
      },
    );
  }
}
