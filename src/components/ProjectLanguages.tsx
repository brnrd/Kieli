import { useState } from "react";
import { Plus, ArrowRight } from "lucide-react";
import type { Project, ProjectStats, Locale } from "../shared";
import { api } from "./api";
import { LanguageMark } from "./ui";

export default function ProjectLanguages({
  project,
  manager,
  stats,
  onAdd,
  onView,
  onChanged,
}: {
  project: Project;
  manager: boolean;
  stats: ProjectStats;
  onAdd: () => void;
  onView: (code: string) => void;
  onChanged: (project: Project) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function toggle(locale: Locale) {
    setBusy(locale.code);
    setError("");
    try {
      onChanged(
        await api<Project>(
          `projects/${project.id}/languages/${encodeURIComponent(locale.code)}`,
          {
            method: "POST",
            body: JSON.stringify({
              version: project.version,
              enabled: !!locale.disabled,
            }),
          },
        ),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <div className="section-title standalone">
        <div>
          <h2>Project languages</h2>
          <p>
            Disable a target to pause work. Its copy and history are retained.
          </p>
        </div>
        {manager && !project.archivedAt && (
          <button className="button" onClick={onAdd}>
            <Plus size={16} />
            Add a language
          </button>
        )}
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error} Reload the page if settings changed elsewhere.
        </div>
      )}
      <div className="language-cards">
        {project.languages.map((locale) => {
          const percent = stats.totalKeys
            ? Math.round(
                ((stats.byLanguage[locale.code] ?? 0) / stats.totalKeys) * 100,
              )
            : 0;
          return (
            <div
              className={`language-card${locale.disabled ? " language-disabled" : ""}`}
              key={locale.code}
            >
              <div className="language-card-top">
                <LanguageMark code={locale.code} />
                <div>
                  <h3>{locale.name}</h3>
                  <span>{locale.code}</span>
                </div>
                {locale.code === project.sourceLanguage ? (
                  <span className="source-pill">SOURCE</span>
                ) : (
                  locale.disabled && <span className="role-pill">Disabled</span>
                )}
              </div>
              {locale.disabled ? (
                <p className="muted">
                  Excluded from editing, completion and default exports.
                </p>
              ) : (
                <>
                  <div className="language-progress">
                    <strong>
                      {percent}
                      <span>%</span>
                    </strong>
                    <span>
                      {stats.byLanguage[locale.code] ?? 0} of{" "}
                      {stats.totalKeys.toLocaleString()} keys
                    </span>
                  </div>
                  <progress value={percent} max="100" />
                </>
              )}
              <div className="language-actions">
                {!locale.disabled && (
                  <button
                    className="text-button"
                    onClick={() => onView(locale.code)}
                  >
                    View translations
                    <ArrowRight size={14} />
                  </button>
                )}
                {manager && locale.code !== project.sourceLanguage && (
                  <button
                    className="button small"
                    disabled={!!busy || !!project.archivedAt}
                    aria-label={`${locale.disabled ? "Enable" : "Disable"} ${locale.name}`}
                    onClick={() => void toggle(locale)}
                  >
                    {busy === locale.code
                      ? "Saving…"
                      : locale.disabled
                        ? "Enable"
                        : "Disable"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted">
        Explicit API and CLI exports can still retrieve disabled languages.
        Published mobile releases stay available; new releases include enabled
        languages only.
      </p>
    </>
  );
}
