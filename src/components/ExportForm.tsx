import { enabledLanguages } from "../shared";
import { useState, type SyntheticEvent } from "react";
import { ArrowDownToLine, Code2, Loader2 } from "lucide-react";
import type { Project } from "../shared";
import { LanguageMark } from "./ui";
import FileFormatSelect from "./FileFormatSelect";
export default function ExportForm({
  project,
  onClose,
  notify,
}: {
  project: Project;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [locales, setLocales] = useState(
    enabledLanguages(project).map((l) => l.code),
  );
  const [format, setFormat] = useState("flat");
  const [fallback, setFallback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({
        languages: locales.join(","),
        format,
        fallback: String(fallback),
        download: "zip",
      });
      const response = await fetch(
        `/api/projects/${project.id}/export?${query}`,
      );
      if (response.status === 401) {
        window.location.assign("/login");
        throw new Error("Your session expired. Sign in again.");
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "Unable to export translations.");
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.id}-${format}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Your translations are ready to go.");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={download}>
      <fieldset className="form-fieldset" disabled={busy}>
        <div className="dialog-body">
          <span className="field-label">Languages</span>
          <div className="export-locales">
            {project.languages.map((l) => (
              <label key={l.code}>
                <input
                  type="checkbox"
                  checked={locales.includes(l.code)}
                  onChange={() =>
                    setLocales((v) =>
                      v.includes(l.code)
                        ? v.filter((c) => c !== l.code)
                        : [...v, l.code],
                    )
                  }
                />
                <LanguageMark code={l.code} small />
                {l.name}
                {l.disabled ? " (disabled)" : ""}
                <small>{l.code}</small>
              </label>
            ))}
          </div>
          {project.languages.some((locale) => locale.disabled) && (
            <p className="muted">
              Disabled languages are excluded by default. Select one above to
              export its retained copy.
            </p>
          )}
          <FileFormatSelect value={format} onChange={setFormat} />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fallback}
              onChange={(e) => setFallback(e.target.checked)}
            />
            <span>
              Use source copy for missing translations
              <small>
                Otherwise, missing translations export as empty strings.
              </small>
            </span>
          </label>
          <div className="info-note">
            <Code2 size={18} />
            <p>
              {format === "stringsdict"
                ? "Downloads a ZIP with a .stringsdict and companion .strings file per selected language."
                : "Downloads a ZIP with one file per selected language."}{" "}
              The CLI can pull the same format directly into your repository.
            </p>
          </div>
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
            className="button primary"
            type="submit"
            disabled={!locales.length}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <ArrowDownToLine size={16} />
            )}
            Download ZIP
          </button>
        </div>
      </fieldset>
    </form>
  );
}
