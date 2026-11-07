import { enabledLanguages } from "../shared";
import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared";
import type { ImportPreview, ImportKey } from "../lokalise";
import type { UpdateEntry } from "../server/project-updates";
import { importExtensions } from "../formats";
import { api, ApiError } from "./api";
type Plan = {
  id: string;
  created: number;
  updated: number;
  unchanged: number;
  entries: UpdateEntry[];
  unresolvedReferences?: string[];
};
export default function ProjectUpdate({
  project,
  onBusyChange,
  onComplete,
  onCancel,
}: {
  project: Project;
  onBusyChange: (busy: boolean) => void;
  onComplete: () => Promise<void>;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File>(),
    [language, setLanguage] = useState(""),
    [policy, setPolicy] = useState<"merge" | "source" | "overwrite">("merge"),
    [plans, setPlans] = useState<Plan[]>([]),
    [parsed, setParsed] = useState<ImportPreview>(),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [accepted, setAccepted] = useState(false),
    [processed, setProcessed] = useState(0),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<UpdateEntry>();
  const worker = useRef<Worker>(null),
    offset = useRef(0);
  useEffect(() => () => worker.current?.terminate(), []);
  function working(value: boolean) {
    setBusy(value);
    onBusyChange(value);
  }
  async function parse() {
    if (!file) throw new Error("Choose a localization file or ZIP.");
    if (file.size > 10 * 1024 * 1024)
      throw new Error("Choose a file smaller than 10 MB.");
    const bytes = await file.arrayBuffer();
    return new Promise<ImportPreview>((resolve, reject) => {
      const parser = new Worker(
        new URL("../workers/lokalise.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.current = parser;
      const timeout = setTimeout(() => {
        parser.terminate();
        reject(new Error("Parsing took too long. Try a smaller file."));
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
        reject(new Error("Unable to parse this localization file."));
      };
      parser.postMessage(
        {
          bytes,
          filename: file.name,
          kind: "files",
          language,
          updateExisting: true,
        },
        [bytes],
      );
    });
  }
  async function preview() {
    working(true);
    setError("");
    setReady(false);
    setPlans([]);
    setProcessed(0);
    setSelected(undefined);
    offset.current = 0;
    setPage(0);
    try {
      const catalog = await parse();
      setParsed(catalog);
      setAccepted(false);
      const batches: ImportKey[][] = [];
      let group: ImportKey[] = [],
        bytes = 0;
      for (const key of catalog.keys) {
        const size = new TextEncoder().encode(JSON.stringify(key)).length;
        if (group.length && (group.length === 20 || bytes + size > 180000)) {
          batches.push(group);
          group = [];
          bytes = 0;
        }
        group.push(key);
        bytes += size;
      }
      if (group.length) batches.push(group);
      const result: Plan[] = [];
      async function inspect(keys: ImportKey[]): Promise<void> {
        try {
          const plan = await api<Plan>(
            `projects/${project.id}/updates/preview`,
            { method: "POST", body: JSON.stringify({ keys, policy }) },
          );
          result.push(plan);
          setProcessed((count) => count + keys.length);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 413 &&
            keys.length > 1
          ) {
            const middle = Math.ceil(keys.length / 2);
            await inspect(keys.slice(0, middle));
            await inspect(keys.slice(middle));
          } else throw error;
        }
      }
      for (const batch of batches) await inspect(batch);
      setPlans(result);
      setReady(true);
      setProcessed(0);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      working(false);
    }
  }
  async function apply() {
    working(true);
    setError("");
    try {
      for (; offset.current < plans.length; offset.current++) {
        const plan = plans[offset.current]!;
        await api(`projects/${project.id}/updates/${plan.id}/apply`, {
          method: "POST",
        });
        setProcessed((count) => count + plan.entries.length);
      }
      await onComplete();
    } catch (error) {
      setError(
        `${processed ? "Earlier batches remain saved. " : ""}${(error as Error).message} Retry the same preview after a network failure; if the project changed, preview the files again.`,
      );
    } finally {
      working(false);
    }
  }
  const entries = plans.flatMap((plan) => plan.entries),
    counts = plans.reduce(
      (sum, plan) => ({
        created: sum.created + plan.created,
        updated: sum.updated + plan.updated,
        unchanged: sum.unchanged + plan.unchanged,
      }),
      { created: 0, updated: 0, unchanged: 0 },
    );
  return (
    <>
      <div className="dialog-body project-update-body">
        <p>
          Update this project from a localization file or ZIP. Descriptions,
          tags, namespaces and keys absent from the files are retained. Apple
          integer-format changes are shown in the preview. Add new languages in
          project settings first.
        </p>
        <details className="update-options" open={!ready}>
          <summary>File and update options</summary>
          <fieldset className="form-fieldset" disabled={busy}>
            <label className="field-label">
              Localization file or ZIP
              <input
                type="file"
                accept={importExtensions}
                onChange={(event) => {
                  setFile(event.target.files?.[0]);
                  setReady(false);
                }}
              />
            </label>
            <label className="field-label">
              File language
              <input
                value={language}
                maxLength={35}
                placeholder={project.sourceLanguage}
                onChange={(event) => {
                  setLanguage(event.target.value);
                  setReady(false);
                }}
              />
              <small>
                Optional, for a single file without a locale filename
              </small>
            </label>
            <label className="field-label">
              Update behavior
              <select
                value={policy}
                onChange={(event) => {
                  setPolicy(event.target.value as typeof policy);
                  setReady(false);
                }}
              >
                <option value="merge">
                  Update source and fill missing targets
                </option>
                <option value="source">Update source only</option>
                <option value="overwrite">
                  Replace supplied target translations too
                </option>
              </select>
            </label>
            <p className="muted">
              {policy === "overwrite"
                ? "Non-empty supplied translations may replace existing copy. Inspect the before/after preview before applying."
                : "Existing non-empty target translations are preserved. Source changes mark unchanged translations outdated."}
            </p>
          </fieldset>
        </details>
        <p className="muted">
          Files are parsed locally. Preview sends parsed values to Kieli;
          project copy changes only when you apply. Each batch commits
          atomically. Keep this dialog open to retry an interrupted apply.
        </p>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <p role="status">
            {ready ? "Applying" : "Inspecting"} {processed.toLocaleString()} of{" "}
            {parsed?.keys.length.toLocaleString() ?? "…"} keys…
          </p>
        )}
        {ready && (
          <>
            {plans.some((plan) => plan.unresolvedReferences?.length) && (
              <p className="field-warning">
                Some referenced keys are outside their preview batch. They must
                exist before that batch applies; references are validated again
                during the atomic write.
              </p>
            )}
            <div className="import-summary">
              <div>
                <strong>{counts.created}</strong>
                <span>new keys</span>
              </div>
              <div>
                <strong>{counts.updated}</strong>
                <span>updated</span>
              </div>
              <div>
                <strong>{counts.unchanged}</strong>
                <span>unchanged</span>
              </div>
            </div>
            <p>
              {entries.reduce((sum, entry) => sum + entry.preserved.length, 0)}{" "}
              supplied target values differ and will be preserved.
            </p>
            {parsed?.warnings.length ? (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={busy}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>
                  I understand these format conversions:{" "}
                  {parsed.warnings.join(" ")}
                </span>
              </label>
            ) : null}
            <div className="history-list">
              {entries.slice(page * 25, (page + 1) * 25).map((entry) => (
                <div className="history-row" key={entry.name}>
                  <div>
                    <strong>{entry.name}</strong>
                    <span>
                      {entry.action}
                      {entry.preserved.length
                        ? ` · preserved ${entry.preserved.join(", ")}`
                        : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSelected(entry)}
                  >
                    Inspect changes
                  </button>
                </div>
              ))}
            </div>
            <div className="pagination">
              <button
                type="button"
                className="button"
                disabled={busy || page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span>Page {page + 1}</span>
              <button
                type="button"
                className="button"
                disabled={busy || (page + 1) * 25 >= entries.length}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
            {selected && (
              <section className="update-diff">
                <h3>{selected.name}</h3>
                {enabledLanguages(project)
                  .filter((locale) =>
                    Object.hasOwn(selected.translations, locale.code),
                  )
                  .map((locale) => (
                    <div key={locale.code}>
                      <strong>{locale.name}</strong>
                      <div className="history-diff">
                        <div>
                          <small>Before</small>
                          <pre>
                            {selected.before?.translations[locale.code] ??
                              "(empty)"}
                          </pre>
                        </div>
                        <div>
                          <small>After</small>
                          <pre>{selected.after.translations[locale.code]}</pre>
                        </div>
                      </div>
                    </div>
                  ))}
                {enabledLanguages(project)
                  .filter(
                    (locale) =>
                      selected.before?.applePluralTypes?.[locale.code] !==
                      selected.after.applePluralTypes?.[locale.code],
                  )
                  .map((locale) => (
                    <p key={`apple-${locale.code}`}>
                      Apple integer format ({locale.name}):{" "}
                      {selected.before?.applePluralTypes?.[locale.code] ??
                        "d (default)"}{" "}
                      →{" "}
                      {selected.after.applePluralTypes?.[locale.code] ??
                        "d (default)"}
                    </p>
                  ))}
                {!Object.keys(selected.translations).length && (
                  <p>No translation text will change.</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
      <div className="dialog-footer">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !file}
          onClick={() => void preview()}
        >
          {ready ? "Preview again" : "Preview changes"}
        </button>
        {ready && (
          <button
            type="button"
            className="button primary"
            disabled={busy || (!!parsed?.warnings.length && !accepted)}
            onClick={() => void apply()}
          >
            Apply changes
          </button>
        )}
      </div>
    </>
  );
}
