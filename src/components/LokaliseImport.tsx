import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  FileArchive,
  Loader2,
  Upload,
} from "lucide-react";
import type { ImportPreview } from "../lokalise";
import type { Project } from "../shared";
import { projectSchema } from "../validation";
import { api } from "./api";
import { LanguageMark } from "./ui";
import { fileFormats, importExtensions } from "../formats";

export default function LokaliseImport({
  onBusyChange,
  onCancel,
  onComplete,
  kind = "lokalise",
}: {
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onComplete: (project: Project) => void;
  kind?: "lokalise" | "files";
}) {
  const [preview, setPreview] = useState<ImportPreview>();
  const [file, setFile] = useState<File>();
  const [platform, setPlatform] = useState("web");
  const [language, setLanguage] = useState("");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState(0);
  const [started, setStarted] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const importId = useRef("");
  const offset = useRef(0);
  const worker = useRef<Worker>(null);
  useEffect(
    () => () => {
      worker.current?.terminate();
    },
    [],
  );
  function working(value: boolean) {
    setBusy(value);
    onBusyChange(value);
  }
  async function inspect() {
    if (!file) return;
    setError("");
    working(true);
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("Choose a file smaller than 10 MB.");
      const bytes = await file.arrayBuffer();
      const result = await new Promise<ImportPreview>((resolve, reject) => {
        const parser = new Worker(
          new URL("../workers/lokalise.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.current = parser;
        const timeout = setTimeout(() => {
          parser.terminate();
          reject(new Error("Parsing took too long. Try a smaller export."));
        }, 30000);
        parser.onmessage = (event) => {
          clearTimeout(timeout);
          parser.terminate();
          event.data.error
            ? reject(new Error(event.data.error))
            : resolve(event.data.preview);
        };
        parser.onerror = () => {
          clearTimeout(timeout);
          parser.terminate();
          reject(
            new Error(
              "Unable to read this export. Check the file and try again.",
            ),
          );
        };
        parser.postMessage(
          { bytes, filename: file.name, platform, kind, language },
          [bytes],
        );
      });
      setPreview(result);
      setName(result.name.slice(0, 80));
      setId(
        result.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 48) || "imported-project",
      );
      setSource(result.sourceLanguage);
      setAccepted(false);
      importId.current = crypto.randomUUID();
      offset.current = 0;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      working(false);
    }
  }
  async function runImport() {
    if (!preview) return;
    working(true);
    setError("");
    try {
      const data = projectSchema.parse({
        id,
        name,
        description: preview.description.slice(0, 500),
        sourceLanguage: source,
        languages: preview.languages,
        color: "sage",
      });
      const project = await api<Project>(`imports/${kind}/start`, {
        method: "POST",
        body: JSON.stringify({ importId: importId.current, project: data }),
      });
      setStarted(true);
      while (offset.current < preview.keys.length) {
        // Keep each request below the API size limit, including unusually long translations.
        const batch = [];
        let bytes = 0;
        for (const key of preview.keys.slice(
          offset.current,
          offset.current + 20,
        )) {
          const size = new TextEncoder().encode(JSON.stringify(key)).length;
          if (batch.length && bytes + size > 220000) break;
          batch.push(key);
          bytes += size;
        }
        await api(`projects/${id}/import`, {
          method: "POST",
          body: JSON.stringify({ importId: importId.current, keys: batch }),
        });
        offset.current += batch.length;
        setImported(offset.current);
      }
      working(false);
      onComplete(project);
    } catch (e) {
      setError((e as Error).message);
      working(false);
    }
  }
  return (
    <>
      <div className="dialog-body import-body">
        {!preview ? (
          <>
            {kind === "lokalise" ? (
              <ol className="import-instructions">
                <li>
                  In Lokalise, open <strong>Download</strong> and choose{" "}
                  <strong>JSON</strong>.
                </li>
                <li>
                  Select all your languages,{" "}
                  <strong>one file per language</strong>, and{" "}
                  <code>%LANG_ISO%.json</code> as the file structure.
                </li>
                <li>
                  Include all platform keys and untranslated strings. Keep
                  missing translations empty, then download the ZIP.
                </li>
              </ol>
            ) : (
              <p className="format-intro">
                Import a translation file or a ZIP of language files into a new
                project. Name files with their language code (en.json,
                fr.strings), or use locale directories. Existing projects stay
                untouched.
              </p>
            )}
            <label className="import-file">
              <FileArchive size={27} />
              <strong>
                {file?.name ??
                  (kind === "lokalise"
                    ? "Choose a Lokalise export"
                    : "Choose translation files")}
              </strong>
              <span>
                {kind === "lokalise"
                  ? "JSON ZIP, language JSON, or API snapshot"
                  : "Translation file or ZIP archive"}{" "}
                · up to 10 MB
              </span>
              <input
                type="file"
                accept={kind === "lokalise" ? ".zip,.json" : importExtensions}
                aria-label={
                  kind === "lokalise"
                    ? "Choose a Lokalise export"
                    : "Choose translation files"
                }
                disabled={busy}
                onChange={(e) => {
                  setFile(e.target.files?.[0]);
                  setError("");
                }}
              />
            </label>
            {kind === "lokalise" ? (
              <label className="field-label">
                Key platform
                <select
                  disabled={busy}
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                >
                  <option value="web">Web</option>
                  <option value="ios">iOS</option>
                  <option value="android">Android</option>
                  <option value="other">Other</option>
                </select>
                <small>For API snapshots with per-platform names</small>
              </label>
            ) : (
              <>
                <label className="field-label">
                  File language
                  <input
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    disabled={busy}
                    placeholder="e.g. en or pt-BR"
                    maxLength={35}
                  />
                  <small>
                    Optional, for a single file without a language filename
                  </small>
                </label>
                <details className="format-support">
                  <summary>Supported formats and limits</summary>
                  <ul>
                    {fileFormats
                      .filter((format) => format.id !== "nested")
                      .map((format) => (
                        <li key={format.id}>
                          <strong>{format.label}</strong>
                          <span>{format.note}</span>
                        </li>
                      ))}
                  </ul>
                  <p>
                    Document translation (.doc, .docx, .pptx, .idml),
                    spreadsheets (.xls, .xlsx), .stf, .html, .srt, .xcstrings
                    and .xcloc are not supported yet.
                  </p>
                </details>
              </>
            )}
            <p className="import-privacy">
              Files are read locally for the preview. Translations are sent to
              Kieli only when you choose Import project.
              {kind === "lokalise" && " No Lokalise credentials needed."}
            </p>
          </>
        ) : (
          <>
            <div className="import-summary">
              <div>
                <strong>{preview.keys.length.toLocaleString()}</strong>
                <span>keys</span>
              </div>
              <div>
                <strong>{preview.languages.length}</strong>
                <span>languages</span>
              </div>
              <div>
                <strong>
                  {Object.values(preview.keys)
                    .reduce(
                      (sum, k) =>
                        sum +
                        Object.values(k.translations).filter((v) => v.trim())
                          .length,
                      0,
                    )
                    .toLocaleString()}
                </strong>
                <span>translations</span>
              </div>
            </div>
            <fieldset className="form-fieldset" disabled={busy || started}>
              <div className="field-grid">
                <label className="field-label">
                  Project name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                    required
                  />
                </label>
                <label className="field-label">
                  New project ID
                  <input
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    maxLength={48}
                    pattern="[a-z0-9][a-z0-9-]*"
                    className="mono-input"
                    required
                  />
                </label>
              </div>
              <label className="field-label">
                Source language
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  {preview.languages.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name} ({l.code})
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            <div className="import-language-list">
              {preview.languages.map((l) => (
                <span key={l.code}>
                  <LanguageMark code={l.code} small />
                  {l.code}
                </span>
              ))}
            </div>
            <div className="import-sample">
              <span className="eyebrow">PREVIEW · FIRST 5 KEYS</span>
              {preview.keys.slice(0, 5).map((k) => (
                <div key={k.name}>
                  <code>{k.name}</code>
                  <span dir="auto">
                    {k.translations[source] || "Empty source translation"}
                  </span>
                </div>
              ))}
            </div>
            {preview.warnings.length > 0 && (
              <div className="import-warnings">
                <strong>
                  <AlertCircle size={15} />
                  Before you import
                </strong>
                <ul>
                  {preview.warnings.slice(0, 15).map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                  {preview.warnings.length > 15 && (
                    <li>
                      {preview.warnings.length - 15} more language code
                      normalizations.
                    </li>
                  )}
                </ul>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                    disabled={busy || started}
                  />
                  <span>I understand these changes.</span>
                </label>
              </div>
            )}
            {started && (
              <div className="import-progress" role="status">
                <div>
                  <span>{busy ? "Importing…" : "Import paused"}</span>
                  <strong>
                    {imported.toLocaleString()} /{" "}
                    {preview.keys.length.toLocaleString()} keys
                  </strong>
                </div>
                <progress max={preview.keys.length} value={imported} />
                <p>
                  {busy
                    ? "Keep this window open. Each batch is saved atomically."
                    : "Completed batches are saved. Retry safely to continue without overwriting translations."}
                </p>
              </div>
            )}
          </>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="dialog-footer">
        {preview && !started && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setPreview(undefined);
              setError("");
            }}
          >
            <ArrowLeft size={14} />
            Choose another file
          </button>
        )}
        <span className="footer-spacer" />
        <button className="button" disabled={busy} onClick={onCancel}>
          {started ? "Close" : "Cancel"}
        </button>
        {preview ? (
          <button
            className="button primary"
            disabled={
              busy ||
              !name.trim() ||
              !id ||
              (preview.warnings.length > 0 && !accepted)
            }
            onClick={() => void runImport()}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Upload size={16} />
            )}{" "}
            {started ? "Retry import" : "Import project"}
          </button>
        ) : (
          <button
            className="button primary"
            disabled={!file || busy}
            onClick={() => void inspect()}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <ArrowRight size={16} />
            )}
            Preview import
          </button>
        )}
      </div>
    </>
  );
}
