import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { SsoDirectory, ssoAudit, type SsoUser } from "./sso-directory";
import { Conflict, type Store } from "./store";
const settingsSchema = z
  .object({
    origin: z.url(),
    appId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    apiToken: z.string().min(20).max(4096),
  })
  .strict();
let cached:
  { arn: string; settings: ReconcileSettings; until: number } | undefined;
export type ReconcileSettings = z.infer<typeof settingsSchema>;
export async function reconciliationSettings(): Promise<
  ReconcileSettings | undefined
> {
  const arn = process.env.SSO_RECONCILE_SECRET_ARN;
  let input: unknown;
  if (arn) {
    if (cached?.arn === arn && cached.until > Date.now())
      return cached.settings;
    const result = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    if (!result.SecretString)
      throw new Error("Reconciliation secret unavailable.");
    input = JSON.parse(result.SecretString);
  } else {
    if (
      !process.env.SSO_OKTA_ORIGIN &&
      !process.env.SSO_OKTA_APP_ID &&
      !process.env.SSO_OKTA_API_TOKEN
    )
      return undefined;
    input = {
      origin: process.env.SSO_OKTA_ORIGIN,
      appId: process.env.SSO_OKTA_APP_ID,
      apiToken: process.env.SSO_OKTA_API_TOKEN,
    };
  }
  const settings = settingsSchema.parse(input),
    url = new URL(settings.origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("Use an exact HTTPS Okta organization origin.");
  settings.origin = url.origin;
  if (arn) cached = { arn, settings, until: Date.now() + 300000 };
  return settings;
}
type Progress = {
  version: number;
  cursor: string;
  lastRun: string;
  lastCompleteCycle?: string;
  lastChecked: number;
  failures: number;
  cycleFailures?: number;
};
export class SsoReconciler {
  readonly directory: SsoDirectory;
  constructor(
    readonly store: Store,
    readonly settings: ReconcileSettings,
    readonly fetcher: typeof fetch = fetch,
  ) {
    this.directory = new SsoDirectory(store);
  }
  private async get(path: string, deadline: number) {
    if (Date.now() >= deadline)
      throw new Error("Reconciliation time budget exhausted.");
    const url = new URL(path, this.settings.origin);
    if (
      url.origin !== this.settings.origin ||
      !url.pathname.startsWith("/api/v1/") ||
      url.username ||
      url.password
    )
      throw new Error("Invalid Okta API target.");
    const response = await this.fetcher(url, {
      headers: {
        authorization: `SSWS ${this.settings.apiToken}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(5000, deadline - Date.now())),
      ),
    });
    if (response.status === 404) return { response, value: undefined };
    if (!response.ok)
      throw new Error(`Okta directory request failed (${response.status}).`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty directory response.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024)
          throw new Error("Directory response exceeds 1 MiB.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return {
      response,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
  }
  async inspect(user: SsoUser, deadline = Date.now() + 15000) {
    const subject = encodeURIComponent(user.subject),
      record = await this.get(`/api/v1/users/${subject}`, deadline);
    let active = false,
      groups: string[] = [];
    if (record.value !== undefined) {
      const profile = z
        .object({ id: z.string(), status: z.string() })
        .parse(record.value);
      if (profile.id !== user.subject)
        throw new Error("SSO subject must be the immutable Okta user ID.");
      if (profile.status === "ACTIVE") {
        const assignment = await this.get(
          `/api/v1/apps/${this.settings.appId}/users/${subject}`,
          deadline,
        );
        if (assignment.value !== undefined) {
          const assigned = z
            .object({ id: z.string(), status: z.string() })
            .parse(assignment.value);
          if (assigned.id !== user.subject)
            throw new Error("Unexpected application assignment.");
          if (["ACTIVE", "PROVISIONED"].includes(assigned.status)) {
            active = true;
            const groupPath = `/api/v1/users/${subject}/groups`;
            let path: string | undefined = groupPath;
            for (let page = 0; path && page < 10; page++) {
              const result = await this.get(path, deadline);
              if (result.value === undefined)
                throw new Error(
                  "User groups disappeared during reconciliation.",
                );
              const values = z
                .array(
                  z.object({
                    profile: z.object({ name: z.string().max(160) }),
                  }),
                )
                .max(1000)
                .parse(result.value);
              groups.push(...values.map((group) => group.profile.name));
              if (groups.length > 1000)
                throw new Error("Too many directory groups.");
              const next = /<([^>]+)>;\s*rel="next"/.exec(
                result.response.headers.get("link") ?? "",
              )?.[1];
              if (next) {
                const target = new URL(next, this.settings.origin);
                if (
                  target.origin !== this.settings.origin ||
                  target.pathname !== groupPath ||
                  target.username ||
                  target.password
                )
                  throw new Error("Invalid directory pagination target.");
                path = target.href;
              } else path = undefined;
            }
            if (path) throw new Error("Directory pagination limit reached.");
          }
        }
      }
    }
    groups = [
      ...new Set(
        groups.filter(
          (name) =>
            name === "keylo-admin" ||
            /^keylo:[a-z0-9][a-z0-9-]{0,47}:(admin|manager|user)$/.test(name),
        ),
      ),
    ].sort();
    const latest = await this.directory.get(user.id);
    if (!latest || latest.version !== user.version) throw new Conflict();
    // Reconciliation removes stale access; reactivation is always explicit.
    const enabled = user.active && active;
    if (
      enabled === user.active &&
      JSON.stringify(groups) === JSON.stringify(user.reconciledGroups)
    )
      return;
    const state = await this.directory.state();
    await this.store.transact([
      {
        pk: this.directory.scope.pk,
        sk: `USER#${user.id}`,
        value: {
          ...user,
          active: enabled,
          reconciledGroups: groups,
          authVersion: user.authVersion + 1,
          version: user.version + 1,
          updatedAt: new Date().toISOString(),
        },
        expectedVersion: user.version,
      },
      {
        pk: this.directory.scope.pk,
        sk: "META",
        check: true,
        expectedVersion: state.version,
      },
      ssoAudit("sso.access_reconciled", "system:sso-reconciliation", user.id),
    ]);
  }
  async run() {
    const pk = this.directory.scope.pk,
      progress = await this.store.get<Progress>(pk, "RECONCILE");
    const all = (await this.directory.allUsers()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const remaining = all.filter((user) => user.id > (progress?.cursor ?? ""));
    const batch = remaining.slice(0, 100);
    const deadline = Date.now() + 18000;
    let checked = 0,
      failures = 0,
      last = progress?.cursor ?? "";
    for (let i = 0; i < batch.length && Date.now() < deadline; i += 4) {
      const users = batch.slice(i, i + 4),
        results = await Promise.allSettled(
          users.map((user) => this.inspect(user, deadline)),
        );
      checked += users.length;
      failures += results.filter(
        (result) => result.status === "rejected",
      ).length;
      last = users.at(-1)!.id;
    }
    const complete = checked === remaining.length;
    const cycleFailures =
      (progress?.cursor ? (progress.cycleFailures ?? 0) : 0) + failures;
    const next: Progress = {
      version: (progress?.version ?? 0) + 1,
      cursor: complete ? "" : last,
      lastRun: new Date().toISOString(),
      lastChecked: checked,
      failures,
      cycleFailures: complete ? 0 : cycleFailures,
      ...(complete && cycleFailures === 0
        ? { lastCompleteCycle: new Date().toISOString() }
        : progress?.lastCompleteCycle
          ? { lastCompleteCycle: progress.lastCompleteCycle }
          : {}),
    };
    await this.store.put(pk, "RECONCILE", next, progress?.version);
    return {
      status: failures ? "partial-failure" : "ok",
      checked,
      failures,
      cycleComplete: complete,
    };
  }
}
