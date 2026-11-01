import { useState } from "react";
import type { Project, TranslationKey } from "../shared";
import { api } from "./api";
import { ModalShell } from "./ui";
type Preview = {
  name: string;
  version: number;
  projectVersion: number;
  statsVersion: number;
  references: { name: string; languages: string[] }[];
  affectedKeys: number;
};
export default function RenameKey({
  project,
  editing,
  onClose,
  onRenamed,
  onBusyChange,
}: {
  project: Project;
  editing: TranslationKey;
  onClose: () => void;
  onRenamed: (key: TranslationKey) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [name, setName] = useState(editing.name),
    [preview, setPreview] = useState<Preview>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const base = `projects/${project.id}/keys/${encodeURIComponent(editing.name)}`;
      if (!preview)
        setPreview(
          await api<Preview>(`${base}/rename-preview`, {
            method: "POST",
            body: JSON.stringify({ name, version: editing.version }),
          }),
        );
      else {
        const key = await api<TranslationKey>(`${base}/rename`, {
          method: "POST",
          body: JSON.stringify({
            name: preview.name,
            version: preview.version,
            projectVersion: preview.projectVersion,
            statsVersion: preview.statsVersion,
          }),
        });
        await onRenamed(key);
      }
    } catch (error) {
      setError((error as Error).message);
      setPreview(undefined);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <ModalShell
      title="Rename key"
      subtitle={editing.name}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="form-fieldset">
          <div className="dialog-body key-form">
            <label className="field-label">
              New key name
              <input
                autoFocus
                required
                value={name}
                maxLength={180}
                pattern="[a-zA-Z0-9_][a-zA-Z0-9_.\-]*"
                className="mono-input"
                onChange={(event) => {
                  setName(event.target.value);
                  setPreview(undefined);
                  setError("");
                }}
              />
            </label>
            <p className="muted">
              Translations, freshness and history stay with this key. Update its
              name in your application code and source-sync files too.
            </p>
            {preview && (
              <div className="rename-impact" role="status">
                <strong>
                  {preview.references.length
                    ? `${preview.references.length} linked ${preview.references.length === 1 ? "key" : "keys"} will be updated`
                    : "No linked keys to update"}
                </strong>
                {!!preview.references.length && (
                  <ul>
                    {preview.references.map((item) => (
                      <li key={item.name}>
                        <code>{item.name}</code> · {item.languages.join(", ")}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  {preview.affectedKeys} key records will change together,
                  including dependent freshness records.
                </p>
              </div>
            )}
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="dialog-footer">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={name === editing.name}
            >
              {busy ? "Working…" : preview ? "Rename key" : "Preview rename"}
            </button>
          </div>
        </fieldset>
      </form>
    </ModalShell>
  );
}
