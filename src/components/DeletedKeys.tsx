import { useState } from "react";
import type { Project } from "../shared";
import { api } from "./api";
type Item = {
  id: string;
  version: number;
  name: string;
  deletedAt: string;
  deletedBy: string;
  ttl: number;
};
export default function DeletedKeys({
  project,
  notify,
}: {
  project: Project;
  notify: (message: string) => void;
}) {
  const [items, setItems] = useState<Item[]>([]),
    [cursor, setCursor] = useState<string>(),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState<Item>();
  async function load(more = false) {
    setBusy(true);
    setError("");
    try {
      const page = await api<{ items: Item[]; nextCursor?: string }>(
        `projects/${project.id}/trash${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setItems((current) => (more ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="deleted-keys key-history"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !busy) void load();
      }}
    >
      <summary>Deleted keys</summary>
      <p className="muted">
        Keys deleted after this feature was installed can be restored for 30
        days. Existing keys are never overwritten.
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {loaded && !items.length && (
        <p className="muted">No recoverable deleted keys.</p>
      )}
      <div className="history-list">
        {items.map((item) => (
          <div className="history-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>
                Deleted by {item.deletedBy} ·{" "}
                {new Date(item.deletedAt).toLocaleString()}
              </span>
            </div>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirm(item)}
            >
              Restore key
            </button>
          </div>
        ))}
      </div>
      {confirm && (
        <div className="info-note">
          <div>
            <p>
              Restore <strong>{confirm.name}</strong> and its translations?
              Linked copy must still resolve in the current project. Translation
              freshness is retained.
            </p>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirm(undefined)}
            >
              Cancel
            </button>{" "}
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api(`projects/${project.id}/trash/${confirm.id}/restore`, {
                  method: "POST",
                  body: JSON.stringify({ version: confirm.version }),
                })
                  .then(async () => {
                    setConfirm(undefined);
                    notify("Key restored.");
                    await load();
                  })
                  .catch((error) => setError(error.message))
                  .finally(() => setBusy(false));
              }}
            >
              Confirm restore
            </button>
          </div>
        </div>
      )}
      {cursor && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void load(true)}
        >
          Load more deleted keys
        </button>
      )}
      {busy && <p role="status">Loading…</p>}
    </details>
  );
}
