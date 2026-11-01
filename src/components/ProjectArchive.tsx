import { useState } from "react";
import type { Project } from "../shared";
import { api } from "./api";
import { ModalShell } from "./ui";

export default function ProjectArchive({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: (project: Project) => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const archived = !!project.archivedAt;
  async function save() {
    setBusy(true);
    setError("");
    try {
      const saved = await api<Project>(`projects/${project.id}/archive`, {
        method: "POST",
        body: JSON.stringify({ version: project.version, archived: !archived }),
      });
      onChanged(saved);
      setConfirm(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-archive-settings">
      <h3>{archived ? "Archived project" : "Archive project"}</h3>
      <p>
        {archived
          ? `Archived ${new Date(project.archivedAt!).toLocaleDateString()} by ${project.archivedBy ?? "a manager"}. Restore to resume editing.`
          : "Hide this project from default navigation and make it read-only. Translations, history, settings and existing exports are preserved."}
      </p>
      <button
        type="button"
        className="button"
        onClick={() => {
          setError("");
          setConfirm(true);
        }}
      >
        {archived ? "Restore project" : "Archive project"}
      </button>
      {confirm && (
        <ModalShell
          title={archived ? "Restore project?" : "Archive project?"}
          subtitle={project.name}
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <div className="dialog-body">
            <p>
              {archived
                ? "The project will return to navigation and editing will be enabled. Existing project memberships and integration permissions apply again."
                : "Editing and new mobile publications will stop. Existing exports, mobile releases, backups and read access will remain available. Managers can restore this project."}
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
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy
                ? "Saving…"
                : archived
                  ? "Restore project"
                  : "Archive project"}
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
