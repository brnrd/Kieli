import { useEffect, useState } from "react";
import { Radio, Plus, Loader2, Download, RotateCcw, Copy } from "lucide-react";
import type { Project } from "../shared";
import { api } from "./api";
import { ModalShell } from "./ui";
type Release = {
  id: string;
  label: string;
  createdAt: string;
  createdBy: string;
  languages: string[];
};
type State = {
  releases: Release[];
  heads: { channel: string; release: string; version: number }[];
  tokens: { id: string; name: string; createdAt: string }[];
};
export default function OtaDelivery({
  project,
  notify,
}: {
  project: Project;
  notify: (message: string) => void;
}) {
  const [state, setState] = useState<State>({
      releases: [],
      heads: [],
      tokens: [],
    }),
    [label, setLabel] = useState("");
  const [channel, setChannel] = useState("production"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [name, setName] = useState("Mobile application"),
    [secret, setSecret] = useState(""),
    [revoke, setRevoke] = useState<{ id: string; name: string }>();
  const head = state.heads.find((head) => head.channel === channel);
  const refresh = () =>
    api<State>(`projects/${project.id}/releases`).then(setState);
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, [project.id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ota-section">
      <div className="section-title standalone">
        <div>
          <h2>
            <Radio size={18} /> Live app delivery
          </h2>
          <p>
            Publish copy updates for iOS, Android and Flutter. Apps keep their
            bundled or cached copy when offline.
          </p>
        </div>
        <a className="button" href="/downloads/keylo-sdks.zip" download>
          <Download size={14} />
          Client SDKs
        </a>
      </div>
      <p className="muted">
        Publishing creates an immutable release. Draft edits stay in the editor
        until you publish again. Every project language must be complete.
      </p>
      <form
        className="ota-publish"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api(`projects/${project.id}/releases`, {
              method: "POST",
              body: JSON.stringify({
                label: label.trim() || "Translation update",
                channel,
                expectedHeadVersion: head?.version ?? 0,
              }),
            });
            setLabel("");
            await refresh();
            notify("Translation release published.");
          });
        }}
      >
        <label className="field-label">
          Release name
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Checkout copy fixes"
            maxLength={100}
            disabled={busy}
          />
        </label>
        <label className="field-label">
          Channel
          <select
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            disabled={busy}
          >
            <option value="production">Production</option>
            <option value="preview">Preview</option>
          </select>
        </label>
        <button
          className="button primary"
          disabled={busy || !!project.archivedAt}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Radio size={14} />}
          Publish drafts
        </button>
      </form>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="history-list">
        {state.releases.length ? (
          state.releases.map((release) => (
            <div className="history-row" key={release.id}>
              <div>
                <strong>
                  {release.label}{" "}
                  {head?.release === release.id && (
                    <span className="source-pill">LIVE · {channel}</span>
                  )}
                </strong>
                <span>
                  {new Date(release.createdAt).toLocaleString()} ·{" "}
                  {release.languages.length} languages · {release.createdBy}
                </span>
              </div>
              <button
                className="button"
                type="button"
                disabled={
                  busy || !!project.archivedAt || head?.release === release.id
                }
                onClick={() =>
                  void run(async () => {
                    await api(`projects/${project.id}/releases/activate`, {
                      method: "POST",
                      body: JSON.stringify({
                        release: release.id,
                        channel,
                        expectedHeadVersion: head?.version ?? 0,
                      }),
                    });
                    await refresh();
                    notify("Live translation release changed.");
                  })
                }
              >
                <RotateCcw size={13} />
                Activate
              </button>
            </div>
          ))
        ) : (
          <p className="muted">No published releases yet.</p>
        )}
      </div>
      <h3>Delivery keys</h3>
      <p className="muted">
        Delivery keys are readable in mobile apps. They only fetch published
        copy; they cannot read drafts or change your project. Use a separate key
        for each app.
      </p>
      <form
        className="snapshot-create"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await api<{ secret: string }>(
              `projects/${project.id}/delivery-keys`,
              { method: "POST", body: JSON.stringify({ name }) },
            );
            setSecret(result.secret);
            await refresh();
          });
        }}
      >
        <label className="field-label">
          App name
          <input
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </label>
        <button className="button" disabled={busy}>
          <Plus size={14} />
          Create delivery key
        </button>
      </form>
      {secret && (
        <div className="delivery-secret">
          <strong>Copy this delivery key now. It is only shown once.</strong>
          <code>{secret}</code>
          <button
            type="button"
            className="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(secret)
                .then(() => notify("Delivery key copied."))
                .catch(() => setError("Select and copy the key manually."));
            }}
          >
            <Copy size={13} />
            Copy
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setSecret("")}
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="history-list">
        {state.tokens.map((token) => (
          <div className="history-row" key={token.id}>
            <div>
              <strong>{token.name}</strong>
              <span>
                Created {new Date(token.createdAt).toLocaleDateString()}
              </span>
            </div>
            <button
              className="text-button danger-text"
              type="button"
              disabled={busy}
              onClick={() => setRevoke(token)}
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
      <div className="info-note">
        <p>
          Integrate a client once, configure its Keylo URL, project ID, delivery
          key and channel, then call refresh on app launch. The SDK archive
          includes setup examples. Keep a bundled fallback for every string your
          app uses.
        </p>
      </div>
      {revoke && (
        <ModalShell
          title="Revoke this delivery key?"
          subtitle={revoke.name}
          onClose={() => {
            if (!busy) setRevoke(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              Apps using this key will stop fetching updates. Their cached and
              bundled translations remain available. Create and deploy a
              replacement key when needed.
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
              className="button danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(
                    `projects/${project.id}/delivery-keys/${revoke.id}`,
                    { method: "DELETE" },
                  );
                  setRevoke(undefined);
                  await refresh();
                  notify("Delivery key revoked.");
                })
              }
            >
              Revoke key
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
