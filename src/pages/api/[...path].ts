import { BulkMetadata } from "../../server/bulk-metadata";
import { Glossary } from "../../server/glossary";
import { KeyRenames } from "../../server/key-renames";
import { workspaceOverview } from "../../server/workspace";
import type { APIRoute } from "astro";
import { SyncCredentials } from "../../server/sync-credentials";
import { z, ZodError } from "zod";
import { HttpError } from "../../server/auth";
import { Conflict, InvalidCursor } from "../../server/store";
import { service } from "../../server/service";
import { readJSON } from "../../server/http";
import { handleSsoApi } from "../../server/sso-api";
import { handleAccountApi } from "../../server/account-api";
import { mcpCredentials } from "../../server/mcp-credentials";
import { zipSync, strToU8 } from "fflate";
import { TranslationMemory } from "../../server/translation-memory";
import { ProjectHistory } from "../../server/project-history";
import { getStore } from "../../server/store";

export const ALL: APIRoute = async (context) => {
  const { request, params, locals, url } = context;
  try {
    if (params.path === "health" && request.method === "GET")
      return Response.json({ status: "ok" });
    const ssoResponse = await handleSsoApi(context);
    if (ssoResponse) return ssoResponse;
    const accountResponse = await handleAccountApi(context);
    if (accountResponse) return accountResponse;
    const identity = locals.identity;
    if (!identity) throw new HttpError(401, "Sign in to continue.");
    const svc = await service();
    const parts = (params.path ?? "").split("/").map(decodeURIComponent);
    const method = request.method;
    if (parts.join("/") === "workspace/overview" && method === "GET")
      return Response.json(await workspaceOverview(identity, await getStore()));
    if (parts[0] === "bootstrap" && parts.length === 1 && method === "GET")
      return Response.json(await svc.bootstrap(identity));
    if (
      ["imports/lokalise/start", "imports/files/start"].includes(
        parts.join("/"),
      ) &&
      method === "POST"
    )
      return Response.json(
        await svc.startImport(identity, await readJSON(request)),
        { status: 201 },
      );
    if (parts[0] !== "projects")
      throw new HttpError(404, "Endpoint not found.");
    if (parts.length === 1 && method === "POST")
      return Response.json(
        await svc.createProject(identity, await readJSON(request)),
        { status: 201 },
      );
    const id = parts[1];
    if (!id) throw new HttpError(404, "Endpoint not found.");
    if (parts.length === 3 && parts[2] === "archive" && method === "POST")
      return Response.json(
        await svc.setProjectArchived(identity, id, await readJSON(request)),
      );
    if (parts[2] === "metadata") {
      const metadata = new BulkMetadata(await getStore(), svc);
      if (parts.length === 4 && parts[3] === "preview" && method === "POST")
        return Response.json(
          await metadata.preview(identity, id, await readJSON(request)),
        );
      if (parts.length === 4 && method === "GET")
        return Response.json(await metadata.status(identity, id, parts[3]!));
      if (parts.length === 5 && parts[4] === "apply" && method === "POST")
        return Response.json(
          await metadata.apply(
            identity,
            id,
            parts[3]!,
            await readJSON(request),
          ),
        );
      throw new HttpError(404, "Metadata endpoint not found.");
    }
    if (parts[2] === "glossary") {
      const glossary = new Glossary(await getStore());
      if (parts.length === 3 && method === "GET")
        return Response.json(
          await glossary.list(identity, id, {
            query: url.searchParams.get("q") ?? "",
            limit: Number(url.searchParams.get("limit") ?? 50),
            cursor: url.searchParams.get("cursor") ?? undefined,
          }),
        );
      if (parts.length === 3 && method === "POST")
        return Response.json(
          await glossary.save(identity, id, await readJSON(request)),
          { status: 201 },
        );
      if (parts.length === 4 && parts[3] === "lookup" && method === "POST")
        return Response.json(
          await glossary.list(identity, id, await readJSON(request)),
        );
      if (parts.length === 4 && parts[3] === "import" && method === "POST")
        return Response.json(
          await glossary.import(identity, id, await readJSON(request)),
        );
      if (parts.length === 4 && parts[3] === "export" && method === "GET")
        return Response.json(await glossary.export(identity, id));
      if (parts.length === 4 && method === "PATCH")
        return Response.json(
          await glossary.save(identity, id, await readJSON(request), parts[3]!),
        );
      if (parts.length === 4 && method === "DELETE") {
        await glossary.remove(
          identity,
          id,
          parts[3]!,
          Number(url.searchParams.get("version")),
        );
        return new Response(null, { status: 204 });
      }
      throw new HttpError(404, "Glossary endpoint not found.");
    }
    if (parts[2] === "translation-memory" && method === "POST") {
      const memory = new TranslationMemory(await getStore());
      if (parts.length === 3)
        return Response.json(
          await memory.lookup(identity, id, await readJSON(request)),
        );
      if (parts.length === 4 && parts[3] === "index")
        return Response.json(
          await memory.indexBatch(identity, id, await readJSON(request)),
        );
      throw new HttpError(404, "Not found.");
    }
    const history = new ProjectHistory(await getStore());
    if (parts[2] === "snapshots") {
      if (parts.length === 3 && method === "GET")
        return Response.json(await history.list(identity, id));
      if (parts.length === 3 && method === "POST") {
        const data = z
          .object({ label: z.string() })
          .strict()
          .parse(await readJSON(request));
        return Response.json(await history.create(identity, id, data.label), {
          status: 201,
        });
      }
      if (parts[3] && parts.length === 4 && method === "GET")
        return Response.json(await history.manifest(identity, id, parts[3]));
      if (
        parts[3] &&
        parts[4] === "parts" &&
        parts.length === 6 &&
        method === "GET"
      )
        return Response.json(
          await history.part(identity, id, parts[3], Number(parts[5])),
        );
      if (
        parts[3] &&
        parts[4] === "restore" &&
        parts.length === 5 &&
        method === "POST"
      ) {
        const data = z
          .object({ version: z.number().int().positive() })
          .strict()
          .parse(await readJSON(request));
        return Response.json(
          await history.restore(identity, id, parts[3], Number(data.version)),
        );
      }
    }
    if (parts[2] === "releases") {
      if (parts.length === 3 && method === "GET")
        return Response.json(await history.releases(identity, id));
      if (parts.length === 3 && method === "POST")
        return Response.json(
          await history.publish(identity, id, await readJSON(request)),
          { status: 201 },
        );
      if (parts[3] === "activate" && parts.length === 4 && method === "POST")
        return Response.json(
          await history.pointRelease(identity, id, await readJSON(request)),
        );
    }
    if (parts[2] === "delivery-keys") {
      if (parts.length === 3 && method === "POST") {
        const data = z
          .object({ name: z.string() })
          .strict()
          .parse(await readJSON(request));
        return Response.json(
          await history.createDeliveryKey(identity, id, data.name),
          { status: 201 },
        );
      }
      if (parts[3] && parts.length === 4 && method === "DELETE") {
        await history.revokeDeliveryKey(identity, id, parts[3]);
        return new Response(null, { status: 204 });
      }
    }
    if (parts.length === 2) {
      if (method === "GET")
        return Response.json(await svc.project(identity, id));
      if (method === "PATCH")
        return Response.json(
          await svc.updateProject(identity, id, await readJSON(request)),
        );
    }
    if (parts[2] === "languages" && parts.length === 4 && method === "POST")
      return Response.json(
        await svc.setLanguageEnabled(
          identity,
          id,
          parts[3]!,
          await readJSON(request),
        ),
      );
    if (parts[2] === "updates") {
      if (parts.length === 4 && parts[3] === "preview" && method === "POST")
        return Response.json(
          await svc.previewUpdate(identity, id, await readJSON(request)),
        );
      if (parts.length === 5 && parts[4] === "apply" && method === "POST")
        return Response.json(await svc.applyUpdate(identity, id, parts[3]!));
    }
    if (parts[2] === "trash") {
      if (parts.length === 3 && method === "GET")
        return Response.json(
          await svc.deletedKeys(identity, id, {
            limit: 25,
            cursor: url.searchParams.get("cursor") ?? undefined,
          }),
        );
      if (parts.length === 5 && parts[4] === "restore" && method === "POST")
        return Response.json(
          await svc.restoreDeletedKey(
            identity,
            id,
            parts[3]!,
            await readJSON(request),
          ),
        );
    }
    if (parts[2] === "keys") {
      if (parts.length === 5 && parts[4] === "navigation" && method === "GET")
        return Response.json(
          await svc.keyNeighbor(identity, id, parts[3]!, {
            direction: url.searchParams.get("direction"),
            query: url.searchParams.get("q") ?? "",
            status: url.searchParams.get("status") ?? "all",
            namespace: url.searchParams.get("namespace") ?? undefined,
            language: url.searchParams.get("language") ?? undefined,
          }),
        );
      if (parts.length === 3 && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const query = url.searchParams.get("q") ?? "";
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const status = url.searchParams.get("status") ?? "all";
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          query.length > 200 ||
          (cursor?.length ?? 0) > 1024 ||
          !["all", "missing", "complete", "outdated", "incomplete"].includes(
            status,
          )
        )
          throw new HttpError(400, "Invalid pagination or filter parameters.");
        return Response.json(
          await svc.keyPage(identity, id, {
            limit,
            cursor,
            query,
            status: status === "all" ? undefined : status,
            namespace: url.searchParams.get("namespace") ?? undefined,
            languages: url.searchParams.has("language")
              ? [url.searchParams.get("language")!]
              : undefined,
          }),
        );
      }
      if (parts.length === 3 && method === "POST")
        return Response.json(
          await svc.createKey(identity, id, await readJSON(request)),
          { status: 201 },
        );
      if (
        parts.length === 5 &&
        ["rename-preview", "rename"].includes(parts[4]!) &&
        method === "POST"
      )
        return Response.json(
          await new KeyRenames(await getStore(), svc).run(
            identity,
            id,
            parts[3]!,
            await readJSON(request),
            parts[4] === "rename",
          ),
        );
      if (parts.length === 5 && parts[4] === "history" && method === "GET")
        return Response.json(
          await svc.keyHistory(identity, id, parts[3]!, {
            limit: 25,
            cursor: url.searchParams.get("cursor") ?? undefined,
          }),
        );
      if (
        parts.length === 7 &&
        parts[4] === "history" &&
        parts[6] === "restore" &&
        method === "POST"
      )
        return Response.json(
          await svc.restoreTranslation(
            identity,
            id,
            parts[3]!,
            parts[5]!,
            await readJSON(request),
          ),
        );
      if (parts.length === 4 && parts[3]) {
        if (method === "GET")
          return Response.json(await svc.key(identity, id, parts[3]));
        if (method === "PATCH")
          return Response.json(
            await svc.updateKey(
              identity,
              id,
              parts[3],
              await readJSON(request),
            ),
          );
        if (method === "DELETE") {
          const version = Number(url.searchParams.get("version"));
          if (!Number.isSafeInteger(version) || version < 1)
            throw new HttpError(400, "A valid version is required.");
          await svc.deleteKey(identity, id, parts[3], version);
          return new Response(null, { status: 204 });
        }
      }
    }
    if (parts[2] === "summary" && parts.length === 3 && method === "GET")
      return Response.json(await svc.summary(identity, id));
    if (parts[2] === "import" && parts.length === 3 && method === "POST")
      return Response.json(
        await svc.importBatch(identity, id, await readJSON(request)),
      );
    if (parts[2] === "tokens") {
      if (parts.length === 3 && method === "GET")
        return Response.json(await svc.tokens(identity, id));
      if (parts.length === 3 && method === "POST")
        return Response.json(
          await svc.createToken(identity, id, await readJSON(request)),
          { status: 201 },
        );
      if (parts.length === 4 && parts[3] && method === "DELETE") {
        await svc.revokeToken(identity, id, parts[3]);
        return new Response(null, { status: 204 });
      }
    }
    if (parts[2] === "sync-tokens") {
      const credentials = new SyncCredentials(await getStore());
      if (parts.length === 3 && method === "GET")
        return Response.json(await credentials.list(identity, id));
      if (parts.length === 3 && method === "POST")
        return Response.json(
          await credentials.create(identity, id, await readJSON(request)),
          { status: 201 },
        );
      if (parts.length === 4 && method === "DELETE") {
        await credentials.revoke(identity, id, parts[3]!);
        return new Response(null, { status: 204 });
      }
    }
    if (parts[2] === "mcp-tokens") {
      const credentials = await mcpCredentials();
      if (parts.length === 3 && method === "GET")
        return Response.json(await credentials.list(identity, id));
      if (parts.length === 3 && method === "POST")
        return Response.json(
          await credentials.create(identity, id, await readJSON(request)),
          { status: 201 },
        );
      if (parts.length === 4 && parts[3] && method === "DELETE") {
        await credentials.revoke(identity, id, parts[3]);
        return new Response(null, { status: 204 });
      }
    }
    if (parts[2] === "export" && parts.length === 3 && method === "GET") {
      const locales =
        url.searchParams.get("languages")?.split(",").filter(Boolean) ?? [];
      const data = await svc.export(
        identity,
        id,
        locales,
        url.searchParams.get("format") ?? "flat",
        url.searchParams.get("fallback") === "true",
        url.searchParams.get("requireCurrent") === "true",
      );
      if (url.searchParams.get("download") === "zip") {
        const archive = zipSync(
          Object.fromEntries(
            data.files.map((file) => [file.name, strToU8(file.content)]),
          ),
          { level: 6, mtime: new Date("1980-01-01T00:00:00Z") },
        );
        if (archive.byteLength > 4 * 1024 * 1024)
          throw new HttpError(
            413,
            "ZIP exceeds the 4 MB download limit. Export fewer languages or split the project.",
          );
        return new Response(archive, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${id}-translations.zip"`,
          },
        });
      }
      const payload = ["flat", "nested"].includes(data.format)
        ? {
            project: data.project,
            format: data.format,
            translations: data.translations,
          }
        : { project: data.project, format: data.format, files: data.files };
      const body = JSON.stringify(payload, null, 2) + "\n";
      if (
        new TextEncoder().encode(JSON.stringify({ body })).length >
        4 * 1024 * 1024
      )
        throw new HttpError(
          413,
          "Export response exceeds the 4 MB download limit. Export fewer languages or split the project.",
        );
      return new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${id}-translations.json"`,
        },
      });
    }
    throw new HttpError(404, "Endpoint not found.");
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof InvalidCursor)
      return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof Conflict)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof ZodError)
      return Response.json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(" · "),
        },
        { status: 400 },
      );
    console.error(
      "API failure:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return Response.json(
      { error: "Unable to complete the request. Please try again." },
      { status: 500 },
    );
  }
};
