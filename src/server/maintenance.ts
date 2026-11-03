import { createHash, timingSafeEqual } from "node:crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { ProjectHistory } from "./project-history";
import { getStore, Conflict } from "./store";
import { HttpError } from "./errors";
let secretCache: { arn: string; secret: string; until: number } | undefined;
async function secret() {
  const arn = process.env.KIELI_SNAPSHOT_JOB_SECRET_ARN;
  if (arn) {
    if (secretCache?.arn === arn && secretCache.until > Date.now())
      return secretCache.secret;
    const result = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    if (!result.SecretString || result.SecretString.length < 32)
      throw new Error("Invalid job secret.");
    secretCache = {
      arn,
      secret: result.SecretString,
      until: Date.now() + 300000,
    };
    return result.SecretString;
  }
  const value = process.env.KIELI_SNAPSHOT_JOB_TOKEN;
  if (!value || value.length < 32)
    throw new HttpError(503, "Automatic snapshot runner is not configured.");
  return value;
}
export async function authenticateMaintenance(request: Request) {
  const expected = createHash("sha256")
    .update(await secret())
    .digest();
  const supplied = createHash("sha256")
    .update(
      /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1] ?? "",
    )
    .digest();
  if (!timingSafeEqual(expected, supplied))
    throw new HttpError(401, "Invalid job credential.");
}
export async function runSnapshotJob(request: Request) {
  await authenticateMaintenance(request);
  const store = await getStore();
  const previous = await store.get<{ version: number; expires: number }>(
    "WORKSPACE",
    "SNAPSHOT_JOB_LOCK",
  );
  if (previous && previous.expires > Date.now())
    return { status: "already-running" };
  const version = (previous?.version ?? 0) + 1;
  try {
    await store.put(
      "WORKSPACE",
      "SNAPSHOT_JOB_LOCK",
      { version, expires: Date.now() + 60000 },
      previous?.version,
    );
  } catch (error) {
    if (error instanceof Conflict) return { status: "already-running" };
    throw error;
  }
  try {
    const results = await new ProjectHistory(store).maintenance({
      sub: "system:snapshots",
      name: "Automatic snapshots",
      email: "system@kieli.invalid",
      admin: true,
      projects: {},
    });
    return {
      status: results.some((result) => result.status === "failed")
        ? "partial-failure"
        : "ok",
      results,
    };
  } finally {
    await store
      .put(
        "WORKSPACE",
        "SNAPSHOT_JOB_LOCK",
        { version: version + 1, expires: 0 },
        version,
      )
      .catch(() => {});
  }
}

export async function runIdentityJob(request: Request) {
  await authenticateMaintenance(request);
  const { config } = await import("./config");
  if (!["okta", "saml"].includes(config().authMode))
    return { status: "disabled" };
  const { reconciliationSettings, SsoReconciler } =
    await import("./sso-reconcile");
  const settings = await reconciliationSettings();
  if (!settings) return { status: "disabled" };
  const store = await getStore(),
    { SsoDirectory } = await import("./sso-directory"),
    directory = new SsoDirectory(store);
  const pk = directory.scope.pk,
    previous = await store.get<{ version: number; expires: number }>(
      pk,
      "RECONCILE_LOCK",
    );
  if (previous && previous.expires > Date.now())
    return { status: "already-running" };
  const version = (previous?.version ?? 0) + 1;
  try {
    await store.put(
      pk,
      "RECONCILE_LOCK",
      { version, expires: Date.now() + 60000 },
      previous?.version,
    );
  } catch (error) {
    if (error instanceof Conflict) return { status: "already-running" };
    throw error;
  }
  try {
    return await new SsoReconciler(store, settings).run();
  } finally {
    await store
      .put(pk, "RECONCILE_LOCK", { version: version + 1, expires: 0 }, version)
      .catch(() => {});
  }
}
