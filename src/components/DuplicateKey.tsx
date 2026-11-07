import { useState } from "react";
import type { Project, TranslationKey } from "../shared";
import { api } from "./api";
import { ModalShell } from "./ui";
export default function DuplicateKey({
  project,
  editing,
  onClose,
  onCreated,
  onBusyChange,
}: {
  project: Project;
  editing: TranslationKey;
  onClose: () => void;
  onCreated: (key: TranslationKey) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [name, setName] = useState(`${editing.name.slice(0, 175)}.copy`);
  const [copyContext, setContext] = useState(true),
    [copyTargets, setTargets] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <ModalShell
      title="Duplicate key"
      subtitle={editing.name}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          onBusyChange(true);
          setError("");
          try {
            await onCreated(
              await api<TranslationKey>(
                `projects/${project.id}/keys/${encodeURIComponent(editing.name)}/duplicate`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    name,
                    version: editing.version,
                    copyContext,
                    copyTargets,
                  }),
                },
              ),
            );
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
            onBusyChange(false);
          }
        }}
      >
        <fieldset className="form-fieldset" disabled={busy}>
          <div className="dialog-body">
            <label className="field-label">
              New key name
              <input
                autoFocus
                required
                value={name}
                maxLength={180}
                pattern="[a-zA-Z0-9_][a-zA-Z0-9_.\-]*"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={copyContext}
                onChange={(event) => setContext(event.target.checked)}
              />
              Copy description, namespace and tags
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={copyTargets}
                onChange={(event) => setTargets(event.target.checked)}
              />
              Copy enabled target translations
            </label>
            <p className="muted">
              Source copy and plural structure are always copied. Outdated
              targets stay outdated. The new key starts its own history.
              References keep pointing to the same keys.
            </p>
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
            <button className="button primary" disabled={name === editing.name}>
              {busy ? "Creating…" : "Duplicate key"}
            </button>
          </div>
        </fieldset>
      </form>
    </ModalShell>
  );
}
