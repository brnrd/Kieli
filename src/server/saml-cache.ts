import type { CacheItem, CacheProvider } from "@node-saml/node-saml";
import { digest } from "./local-auth";
import { Conflict, type Store } from "./store";

type Entry = {
  version: number;
  value: string;
  createdAt: number;
  expiresAt: number;
  ttl: number;
};
export class SamlCache implements CacheProvider {
  private pk: string;
  constructor(
    private store: Store,
    scope: string,
    private requestId?: string,
  ) {
    this.pk = `SAML_CACHE#${digest(scope)}`;
  }
  private async entry(key: string) {
    return this.store.get<Entry>(this.pk, digest(key));
  }
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    const createdAt = Date.now();
    return (await this.saveIfAbsentAsync(key, value, createdAt + 600000))
      ? { value, createdAt }
      : null;
  }
  async saveIfAbsentAsync(
    key: string,
    value: string,
    expiresAt: number,
  ): Promise<boolean> {
    const old = await this.entry(key);
    if (old && old.expiresAt > Date.now()) return false;
    try {
      await this.store.put(
        this.pk,
        digest(key),
        {
          version: (old?.version ?? 0) + 1,
          value,
          createdAt: Date.now(),
          expiresAt,
          ttl: Math.ceil(expiresAt / 1000),
        },
        old?.version,
      );
      return true;
    } catch (error) {
      if (error instanceof Conflict) return false;
      throw error;
    }
  }
  async getAsync(key: string): Promise<string | null> {
    if (this.requestId && key !== this.requestId) return null;
    const entry = await this.entry(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : null;
  }
  async consumeAsync(key: string): Promise<string | null> {
    if (this.requestId && key !== this.requestId) return null;
    const entry = await this.entry(key);
    if (!entry) return null;
    try {
      await this.store.remove(this.pk, digest(key), entry.version);
    } catch (error) {
      if (error instanceof Conflict) return null;
      throw error;
    }
    return entry.expiresAt > Date.now() ? entry.value : null;
  }
  async removeAsync(key: string | null): Promise<string | null> {
    return key !== null && (await this.consumeAsync(key)) !== null ? key : null;
  }
}
