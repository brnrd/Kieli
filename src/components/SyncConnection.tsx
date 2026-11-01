import { useEffect, useState, type SyntheticEvent } from "react";
import { api } from "./api";
import { ModalShell } from "./ui";
import type { Project } from "../shared";
type Credential = {
  id: string;
  name: string;
  prefix: string;
  prefixes: string[];
  createdByName: string;
  expiresAt: string;
  lastUsedAt?: string;
};
export default function SyncConnection({
  project,
  manager,
  notify,
}: {
  project: Project;
  manager: boolean;
  notify: (message: string) => void;
}) {
  const [items, setItems] = useState<Credential[]>([]),
    [name, setName] = useState("CI source sync"),
    [prefixes, setPrefixes] = useState(""),
    [days, setDays] = useState(90),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revoke, setRevoke] = useState<Credential>(),
    [origin, setOrigin] = useState("https://copy.example.com");
  const refresh = () =>
    api<Credential[]>(`projects/${project.id}/sync-tokens`).then(setItems);
  useEffect(() => {
    setOrigin(window.location.origin);
    if (manager) void refresh().catch((error) => setError(error.message));
  }, [project.id, manager]);
  const config = JSON.stringify(
    {
      url: origin,
      project: project.id,
      sourceLanguage: project.sourceLanguage,
      push: {
        files: [
          {
            path: `./locales/${project.sourceLanguage}.json`,
            format: "nested",
            namespace: "general",
          },
        ],
      },
      pull: {
        out: "./locales",
        format: "nested",
        languages: project.languages.map((locale) => locale.code),
      },
    },
    null,
    2,
  );
  async function create(event: SyntheticEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ secret: string }>(
        `projects/${project.id}/sync-tokens`,
        {
          method: "POST",
          body: JSON.stringify({
            name,
            prefixes: prefixes
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            expiresInDays: days,
          }),
        },
      );
      setSecret(result.secret);
      await refresh();
      notify("Source-sync credential created. Copy it now.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sync-connection">
      <div className="section-title standalone">
        <div>
          <h2>Source sync for CI</h2>
          <p>
            Push source strings from a trusted repository. Target translations
            and existing key metadata stay protected.
          </p>
        </div>
      </div>
      <details className="key-history">
        <summary>Repository configuration</summary>
        <p>
          Save as <code>.keylo.json</code> in the consuming repository.
          Credentials belong in CI secrets.
        </p>
        <pre className="sync-config">{config}</pre>
        <pre className="sync-config">
          {
            "node cli/keylo.mjs push --config .keylo.json\n# Inspect the dry run, then apply:\nnode cli/keylo.mjs push --config .keylo.json --apply"
          }
        </pre>
        <p>
          Set <code>KEYLO_SYNC_TOKEN</code> for push and a separate{" "}
          <code>KEYLO_TOKEN</code> for pull. Push supports flat/nested source
          JSON with ICU strings for plurals.
        </p>
      </details>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {manager ? (
        <>
          <form className="sync-token-form" onSubmit={create}>
            <label className="field-label">
              Credential name
              <input
                value={name}
                maxLength={80}
                required
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field-label">
              Key prefixes
              <input
                value={prefixes}
                disabled={busy}
                placeholder="home., billing."
                onChange={(event) => setPrefixes(event.target.value)}
              />
              <small>
                Optional, comma separated. Leave empty to allow all source keys
                in this project.
              </small>
            </label>
            <label className="field-label">
              Expires in
              <select
                value={days}
                disabled={busy}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>1 year</option>
              </select>
            </label>
            <button type="submit" className="button" disabled={busy}>
              Create source-sync credential
            </button>
          </form>
          <p className="muted">
            These project service credentials are independent of personal
            sessions. Revoke them here when a CI integration is retired or
            access changes.
          </p>
          {secret && (
            <div className="info-note">
              <div>
                <strong>Copy this credential once</strong>
                <pre className="sync-config">{secret}</pre>
                <button
                  type="button"
                  className="button"
                  onClick={() => setSecret("")}
                >
                  Hide credential
                </button>
              </div>
            </div>
          )}
          <div className="history-list">
            {items.map((item) => (
              <div className="history-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.prefix}… ·{" "}
                    {item.prefixes.length
                      ? item.prefixes.join(", ")
                      : "All source keys"}{" "}
                    · expires {new Date(item.expiresAt).toLocaleDateString()}
                  </span>
                  <span>
                    Created by {item.createdByName} ·{" "}
                    {item.lastUsedAt
                      ? `Last used ${new Date(item.lastUsedAt).toLocaleString()}`
                      : "Not used yet"}
                  </span>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setRevoke(item)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
          {!items.length && (
            <p className="muted">No source-sync credentials yet.</p>
          )}
        </>
      ) : (
        <p className="muted">
          Project managers configure CI source synchronization.
        </p>
      )}
      {revoke && (
        <ModalShell
          title="Revoke source-sync access?"
          subtitle={revoke.name}
          onClose={() => {
            if (!busy) setRevoke(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              CI jobs using this credential will stop working. Existing copy and
              translation history remain.
            </p>
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setRevoke(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api(`projects/${project.id}/sync-tokens/${revoke.id}`, {
                  method: "DELETE",
                })
                  .then(async () => {
                    setRevoke(undefined);
                    await refresh();
                    notify("Source-sync credential revoked.");
                  })
                  .catch((error) => setError(error.message))
                  .finally(() => setBusy(false));
              }}
            >
              Revoke credential
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
