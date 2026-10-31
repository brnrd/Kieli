import { canonicalJSON } from "../canonical-json";
import { useEffect, useState } from "react";
import { Archive, Download, Loader2, RotateCcw, Plus } from "lucide-react";
import type { Project } from "../shared";
import { api } from "./api";
import { ModalShell } from "./ui";
type Snapshot = {
  id: string;
  label: string;
  createdAt: string;
  createdBy: string;
  kind: string;
  status: string;
  keys: number;
};
export default function ProjectSnapshots({
  project,
  onProject,
  notify,
}: {
  project: Project;
  onProject: (project: Project) => void;
  notify: (message: string) => void;
}) {
  const [items, setItems] = useState<Snapshot[]>([]),
    [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [restore, setRestore] = useState<Snapshot>();
  const [enabled, setEnabled] = useState(
      project.snapshotPolicy?.enabled ?? false,
    ),
    [hours, setHours] = useState(project.snapshotPolicy?.intervalHours ?? 24),
    [retention, setRetention] = useState(
      project.snapshotPolicy?.retention ?? 7,
    );
  const refresh = () =>
    api<Snapshot[]>(`projects/${project.id}/snapshots`).then(setItems);
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
  async function download(item: Snapshot) {
    const manifest = await api<{
      schema: number;
      project: unknown;
      createdAt: string;
      parts: number;
      keys: number;
      checksum: string;
      checksumVersion: number;
    }>(`projects/${project.id}/snapshots/${item.id}`);
    const keys: unknown[] = [];
    for (let i = 0; i < manifest.parts; i++) {
      const part = await api<{ keys: unknown[] }>(
        `projects/${project.id}/snapshots/${item.id}/parts/${i}`,
      );
      keys.push(...part.keys);
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        canonicalJSON(
          manifest.checksumVersion === 2
            ? { project: manifest.project, keys }
            : keys,
        ),
      ),
    );
    const checksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (keys.length !== manifest.keys || checksum !== manifest.checksum)
      throw new Error(
        "Backup download failed integrity validation. Please retry.",
      );
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              schema: 1,
              project: manifest.project,
              createdAt: manifest.createdAt,
              keys,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.id}-${item.id}.keylo.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="project-history-section">
      <div className="section-title standalone">
        <div>
          <h2>
            <Archive size={18} /> Project snapshots
          </h2>
          <p>
            Save a project, download a backup, or restore an earlier version.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          Refresh
        </button>
      </div>
      <form
        className="snapshot-create"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api(`projects/${project.id}/snapshots`, {
              method: "POST",
              body: JSON.stringify({
                label: label.trim() || "Manual snapshot",
              }),
            });
            setLabel("");
            await refresh();
            notify("Project snapshot saved.");
          });
        }}
      >
        <label className="field-label">
          Snapshot name
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Before the spring launch"
            maxLength={100}
            disabled={busy}
          />
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
          Create snapshot
        </button>
      </form>
      <form
        className="snapshot-policy"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const {
              id,
              name,
              description,
              sourceLanguage,
              languages,
              color,
              version,
            } = project;
            const saved = await api<Project>(`projects/${id}`, {
              method: "PATCH",
              body: JSON.stringify({
                id,
                name,
                description,
                sourceLanguage,
                languages,
                color,
                version,
                snapshotPolicy: { enabled, intervalHours: hours, retention },
              }),
            });
            onProject(saved);
            notify("Snapshot schedule saved.");
          });
        }}
      >
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={busy}
          />
          <span>
            Automatic snapshots
            <small>
              The AWS installer includes a runner. Other installations need the
              documented snapshot job.
            </small>
          </span>
        </label>
        <div className="field-grid">
          <label className="field-label">
            Frequency
            <select
              disabled={busy || !enabled}
              value={hours}
              onChange={(event) => setHours(Number(event.target.value))}
            >
              <option value={24}>Daily</option>
              <option value={168}>Weekly</option>
            </select>
          </label>
          <label className="field-label">
            Keep automatic snapshots
            <input
              disabled={busy || !enabled}
              type="number"
              min={2}
              max={30}
              value={retention}
              onChange={(event) => setRetention(Number(event.target.value))}
            />
          </label>
        </div>
        <button className="button" disabled={busy}>
          Save schedule
        </button>
      </form>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="history-list">
        {items.length ? (
          items.map((item) => (
            <div className="history-row" key={item.id}>
              <div>
                <strong>{item.label}</strong>
                <span>
                  {new Date(item.createdAt).toLocaleString()} ·{" "}
                  {item.keys.toLocaleString()} keys · {item.kind} ·{" "}
                  {item.status}
                </span>
                <small>{item.createdBy}</small>
              </div>
              <div className="history-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy || item.status !== "ready"}
                  onClick={() => void run(() => download(item))}
                >
                  <Download size={13} />
                  Download
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || item.status !== "ready"}
                  onClick={() => setRestore(item)}
                >
                  <RotateCcw size={13} />
                  Restore
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">
            No snapshots yet. Create one before a large change.
          </p>
        )}
      </div>
      {restore && (
        <ModalShell
          title="Restore this project?"
          subtitle={restore.label}
          onClose={() => {
            if (!busy) setRestore(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              This replaces the current keys, translations and language settings
              with this snapshot. A safety snapshot of the current project is
              saved first. Accounts, access permissions and published OTA
              releases are preserved.
            </p>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setRestore(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(
                    `projects/${project.id}/snapshots/${restore.id}/restore`,
                    {
                      method: "POST",
                      body: JSON.stringify({ version: project.version }),
                    },
                  );
                  window.location.assign(`/projects/${project.id}/settings`);
                })
              }
            >
              {busy && <Loader2 size={14} className="spin" />}Restore snapshot
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
