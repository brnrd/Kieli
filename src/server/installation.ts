import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { LocalUser } from "./local-auth";
import { digest, LocalAuth } from "./local-auth";
import { config } from "./config";
import { HttpError } from "./errors";
import { hashPassword } from "./passwords";
import { Conflict, getStore, type Store } from "./store";

const inputSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9]{48}$/),
    name: z.string().trim().min(1).max(80),
    email: z
      .string()
      .trim()
      .max(254)
      .pipe(z.email())
      .transform((value) => value.toLowerCase()),
    password: z.string().min(15).max(128),
  })
  .strict();

export function installationEnabled() {
  return (
    config().authMode === "local" &&
    !!(
      process.env.KEYLO_INSTALL_SECRET_ARN ||
      (!config().production && process.env.KEYLO_INSTALL_TOKEN)
    )
  );
}
async function readSetupToken() {
  const arn = process.env.KEYLO_INSTALL_SECRET_ARN;
  if (!arn) {
    if (config().production)
      throw new Error("An AWS install secret is required.");
    return process.env.KEYLO_INSTALL_TOKEN ?? "";
  }
  // Read the current secret on each attempt; rotation must not leave a cached credential valid.
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const response = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  const secret = z
    .object({
      purpose: z.literal("keylo-install-v1"),
      token: z.string().regex(/^[A-Za-z0-9]{48}$/),
    })
    .parse(JSON.parse(response.SecretString ?? "{}"));
  return secret.token;
}

export class Installation {
  constructor(
    private store: Store,
    private readToken: () => Promise<string> = readSetupToken,
  ) {}
  async available() {
    return (
      installationEnabled() && !(await this.store.get("AUTH_CONTROL", "ADMINS"))
    );
  }
  async complete(input: unknown, client: string) {
    if (!(await this.available()))
      throw new HttpError(
        409,
        "Installation is unavailable or already complete. Sign in or use operator recovery.",
      );
    const auth = new LocalAuth(this.store);
    await auth.limit("install:global", 300);
    await auth.limit(`install:client:${client}`, 30);
    const data = inputSchema.parse(input);
    const expected = await this.readToken();
    if (!/^[A-Za-z0-9]{48}$/.test(expected))
      throw new Error("Invalid install secret configuration.");
    if (
      !timingSafeEqual(
        Buffer.from(digest(data.token), "hex"),
        Buffer.from(digest(expected), "hex"),
      )
    )
      throw new HttpError(
        403,
        "The setup secret is incorrect. Retrieve its current token value from AWS Secrets Manager.",
      );
    const passwordHash = await hashPassword(data.password, [
      data.name,
      data.email,
    ]);
    const at = new Date().toISOString();
    const user: LocalUser = {
      id: randomUUID(),
      name: data.name,
      email: data.email,
      workspaceRole: "admin",
      projects: {},
      status: "active",
      passwordHash,
      version: 1,
      authVersion: 1,
      createdAt: at,
      updatedAt: at,
      searchText: `${data.name}\n${data.email}`.toLowerCase(),
    };
    try {
      // The same insert-only control row is used by operator bootstrap. Exactly one
      // initializer can win, including across concurrent Lambda instances.
      await this.store.transact([
        {
          pk: "AUTH_CONTROL",
          sk: "ADMINS",
          value: { version: 1, activeAdmins: 1 },
        },
        { pk: "USERS", sk: `USER#${user.id}`, value: { ...user } },
        {
          pk: `EMAIL#${digest(user.email)}`,
          sk: "META",
          value: { version: 1, userId: user.id },
        },
        {
          pk: "AUTH_AUDIT",
          sk: `${at}#${randomUUID()}`,
          value: {
            version: 1,
            action: "installation.completed",
            actor: user.id,
            at,
            outcome: "success",
          },
        },
      ]);
    } catch (error) {
      if (error instanceof Conflict)
        throw new HttpError(
          409,
          "Installation was completed by another request. Sign in to continue.",
        );
      throw error;
    }
    return user;
  }
}
export async function installation() {
  return new Installation(await getStore());
}
