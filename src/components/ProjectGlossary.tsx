import type { RefObject } from "react";
import type { EditorHandle } from "./KeyEditor";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import type { Project } from "../shared";
import {
  glossaryFileSchema,
  termIdentity,
  type GlossaryInput,
  type GlossaryPage,
  type GlossaryTerm,
} from "../glossary";
import { api } from "./api";
import { IconButton, ModalShell } from "./ui";
function TermForm({
  project,
  term,
  busy,
  error,
  onSave,
  onDirty,
  onCancel,
}: {
  project: Project;
  term: GlossaryTerm | null;
  busy: boolean;
  error: string;
  onSave: (value: GlossaryInput) => void;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
}) {
  const targets = project.languages.filter(
    (locale) => locale.code !== project.sourceLanguage,
  );
  const [source, setSource] = useState(term?.source ?? ""),
    [notes, setNotes] = useState(term?.notes ?? ""),
    [caseSensitive, setCaseSensitive] = useState(term?.caseSensitive ?? false),
    [translations, setTranslations] = useState<Record<string, string>>(
      Object.fromEntries(
        targets.map((locale) => [
          locale.code,
          term?.translations[locale.code] ?? "",
        ]),
      ),
    );
  const sourceRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => sourceRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const initial = useRef(
    JSON.stringify({ source, notes, caseSensitive, translations }),
  );
  const dirty =
    initial.current !==
    JSON.stringify({ source, notes, caseSensitive, translations });
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  function submit(event: SyntheticEvent) {
    event.preventDefault();
    onSave({
      source,
      notes,
      caseSensitive,
      translations: Object.fromEntries(
        Object.entries(translations).filter(([, value]) => value.trim()),
      ),
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy} className="form-fieldset">
        <div className="dialog-body">
          <label className="field-label">
            Source term{" "}
            <span>{project.sourceLanguage} · one term or phrase</span>
            <input
              autoFocus
              ref={sourceRef}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              required
              maxLength={200}
              lang={project.sourceLanguage}
              dir="auto"
              placeholder="e.g. workspace"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            Match the source term’s exact case
          </label>
          <p className="muted glossary-hint">
            Each source term appears once. Case sensitivity affects matching,
            not uniqueness.
          </p>
          <div className="form-divider">
            <span>TARGET TERMS</span>
          </div>
          <div className="glossary-target-fields">
            {targets.map((locale) => (
              <label className="field-label" key={locale.code}>
                {locale.name} <span>{locale.code}</span>
                <input
                  value={translations[locale.code] ?? ""}
                  onChange={(event) =>
                    setTranslations((values) => ({
                      ...values,
                      [locale.code]: event.target.value,
                    }))
                  }
                  maxLength={300}
                  lang={locale.code}
                  dir="auto"
                  placeholder="Optional target term"
                />
              </label>
            ))}
          </div>
          {!targets.length && (
            <p className="muted">
              This project has no target languages yet. You can still record a
              source term and its notes.
            </p>
          )}
          <label className="field-label">
            Notes <small>optional</small>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Meaning, usage or wording to avoid…"
            />
          </label>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button className="button" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="button primary" type="submit">
            {busy ? "Saving…" : term ? "Save term" : "Add term"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
type ImportPlan = {
  batches: { batchId: string; terms: GlossaryInput[] }[];
  terms: GlossaryInput[];
  index: number;
  added: number;
  skipped: number;
};
export default function ProjectGlossary({
  project,
  manager,
  notify,
  navigationRef,
}: {
  project: Project;
  manager: boolean;
  navigationRef: RefObject<EditorHandle | null>;
  notify: (message: string) => void;
}) {
  const [page, setPage] = useState<GlossaryPage>(),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [cursor, setCursor] = useState<string>(),
    [history, setHistory] = useState<(string | undefined)[]>([]),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<GlossaryTerm | null | undefined>(),
    [formError, setFormError] = useState(""),
    [dirty, setDirty] = useState(false),
    [discard, setDiscard] = useState(false),
    [deleting, setDeleting] = useState<GlossaryTerm>(),
    [plan, setPlan] = useState<ImportPlan>(),
    [importError, setImportError] = useState("");
  const leaveAction = useRef<(() => void) | null>(null);
  useEffect(() => {
    navigationRef.current = {
      requestClose: closeForm,
      requestLeave: (action) => {
        if (busy) return;
        if (dirty) {
          leaveAction.current = action;
          setDiscard(true);
        } else action();
      },
    };
    return () => {
      navigationRef.current = null;
    };
  }, [navigationRef, dirty, busy]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setCursor(undefined);
      setHistory([]);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    setError("");
    setPage(undefined);
    const params = new URLSearchParams({
      q: query,
      limit: "50",
      ...(cursor ? { cursor } : {}),
    });
    void api<GlossaryPage>(`projects/${project.id}/glossary?${params}`)
      .then((value) => {
        if (active) setPage(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [project.id, query, cursor, refresh]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function closeForm() {
    if (busy) return;
    if (dirty) {
      leaveAction.current = null;
      setDiscard(true);
    } else setEditing(undefined);
  }
  function open(term: GlossaryTerm | null) {
    setFormError("");
    setDirty(false);
    setEditing(term);
  }
  async function save(value: GlossaryInput) {
    setBusy(true);
    setFormError("");
    try {
      await api(
        `projects/${project.id}/glossary${editing ? `/${editing.id}` : ""}`,
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            ...value,
            ...(editing ? { version: editing.version } : {}),
          }),
        },
      );
      setEditing(undefined);
      setDirty(false);
      setRefresh((value) => value + 1);
      notify("Glossary term saved.");
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setError("");
    setBusy(true);
    try {
      const file = await api(`projects/${project.id}/glossary/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2) + "\n"], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.id}-glossary.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function readFile(file: File) {
    setError("");
    try {
      if (file.size > 16 * 1024 * 1024)
        throw new Error("Choose a glossary JSON file smaller than 16 MiB.");
      const parsed = glossaryFileSchema.parse(JSON.parse(await file.text()));
      if (parsed.sourceLanguage !== project.sourceLanguage)
        throw new Error(
          "The glossary source language must match this project.",
        );
      if (!parsed.terms.length)
        throw new Error("This glossary contains no terms to import.");
      const names = new Set<string>();
      for (const term of parsed.terms) {
        if (names.has(termIdentity(term.source)))
          throw new Error("The file contains duplicate source terms.");
        names.add(termIdentity(term.source));
        if (
          Object.keys(term.translations).some(
            (code) =>
              code === project.sourceLanguage ||
              !project.languages.some((locale) => locale.code === code),
          )
        )
          throw new Error(
            "Add the file’s target languages to this project before importing.",
          );
      }
      const batches = [];
      for (let i = 0; i < parsed.terms.length; i += 20)
        batches.push({
          batchId: crypto.randomUUID(),
          terms: parsed.terms.slice(i, i + 20),
        });
      setImportError("");
      setPlan({ batches, terms: parsed.terms, index: 0, added: 0, skipped: 0 });
    } catch (error) {
      setError(
        error instanceof SyntaxError
          ? "This file is not valid JSON."
          : error instanceof Error && error.name === "ZodError"
            ? "This is not a supported Keylo glossary file. Export a glossary to see the expected format."
            : (error as Error).message,
      );
    }
  }
  async function apply() {
    if (!plan) return;
    setBusy(true);
    setImportError("");
    let current = plan;
    try {
      while (current.index < current.batches.length) {
        const result = await api<{ added: number; skipped: number }>(
          `projects/${project.id}/glossary/import`,
          {
            method: "POST",
            body: JSON.stringify({
              ...current.batches[current.index],
              sourceLanguage: project.sourceLanguage,
            }),
          },
        );
        current = {
          ...current,
          index: current.index + 1,
          added: current.added + result.added,
          skipped: current.skipped + result.skipped,
        };
        setPlan(current);
      }
      notify(
        `Glossary imported: ${current.added} added, ${current.skipped} existing ${current.skipped === 1 ? "term" : "terms"} kept.`,
      );
      setPlan(undefined);
      setRefresh((value) => value + 1);
    } catch (error) {
      setImportError((error as Error).message);
      setRefresh((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="glossary-page">
      <div className="glossary-heading">
        <div>
          <h2>Shared glossary</h2>
          <p>
            Agree on the words your product uses. Translators can consult them
            while editing.
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => void download()}
          >
            <ArrowDownToLine size={14} />
            Export JSON
          </button>
          {manager && (
            <>
              <label
                className={`button glossary-file ${busy ? "disabled" : ""}`}
              >
                <Upload size={14} />
                Import JSON
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void readFile(file);
                  }}
                />
              </label>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => open(null)}
              >
                <Plus size={14} />
                Add term
              </button>
            </>
          )}
        </div>
      </div>
      {!manager && (
        <p className="muted">
          Terms are maintained by project managers. You can look up and export
          the glossary.
        </p>
      )}
      <div className="admin-toolbar">
        <label className="search-field">
          <Search size={14} />
          <input
            aria-label="Search glossary"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search terms, targets and notes…"
            maxLength={200}
          />
        </label>
        <span className="muted">
          {page
            ? `${page.total} ${page.total === 1 ? "term" : "terms"}`
            : "Loading terms…"}
        </span>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="table-scroll">
        <table className="glossary-table">
          <thead>
            <tr>
              <th>Source term</th>
              <th>Target terms</th>
              <th>Matching</th>
              {manager && (
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {page?.items.map((term) => (
              <tr key={term.id}>
                <td>
                  <strong lang={project.sourceLanguage} dir="auto">
                    {term.source}
                  </strong>
                  {term.notes && (
                    <details className="glossary-notes">
                      <summary>Notes</summary>
                      <p>{term.notes}</p>
                    </details>
                  )}
                </td>
                <td>
                  {Object.entries(term.translations)
                    .filter(([, value]) => value)
                    .map(([code, value]) => (
                      <div className="glossary-target" key={code}>
                        <span>{code}</span>
                        <span lang={code} dir="auto">
                          {value}
                        </span>
                      </div>
                    ))}
                  {!Object.values(term.translations).some(Boolean) && (
                    <span className="muted">No target terms yet</span>
                  )}
                </td>
                <td>
                  <span className="glossary-case">
                    {term.caseSensitive ? "Exact case" : "Any case"}
                  </span>
                </td>
                {manager && (
                  <td>
                    <div className="glossary-actions">
                      <IconButton
                        label={`Edit ${term.source}`}
                        onClick={() => open(term)}
                        disabled={busy}
                      >
                        <Pencil size={14} />
                      </IconButton>
                      <IconButton
                        label={`Delete ${term.source}`}
                        onClick={() => setDeleting(term)}
                        disabled={busy}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page && !page.items.length && (
        <p className="directory-empty">
          {query
            ? "No terms match this search."
            : "Your glossary is ready for its first term."}
        </p>
      )}
      <div className="admin-toolbar">
        <span className="muted">
          Page {history.length + 1} · up to 50 terms
        </span>
        <div className="heading-actions">
          <IconButton
            label="Previous glossary page"
            disabled={!history.length || busy}
            onClick={() => {
              setCursor(history.at(-1));
              setHistory((items) => items.slice(0, -1));
            }}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton
            label="Next glossary page"
            disabled={!page?.nextCursor || busy}
            onClick={() => {
              setHistory((items) => [...items, cursor]);
              setCursor(page!.nextCursor);
            }}
          >
            <ChevronRight size={15} />
          </IconButton>
        </div>
      </div>
      {editing !== undefined && (
        <ModalShell
          title={editing ? "Edit glossary term" : "Add glossary term"}
          onClose={closeForm}
          wide
          className="glossary-term-dialog"
        >
          <TermForm
            project={project}
            term={editing}
            busy={busy}
            error={formError}
            onSave={(value) => void save(value)}
            onDirty={setDirty}
            onCancel={closeForm}
          />
        </ModalShell>
      )}
      {discard && (
        <ModalShell
          title="Discard unsaved term changes?"
          onClose={() => {
            leaveAction.current = null;
            setDiscard(false);
          }}
        >
          <div className="dialog-body">
            <p>Your glossary draft has not been saved.</p>
          </div>
          <div className="dialog-footer">
            <button
              className="button"
              onClick={() => {
                leaveAction.current = null;
                setDiscard(false);
              }}
            >
              Keep editing
            </button>
            <button
              className="button danger"
              onClick={() => {
                setDiscard(false);
                setDirty(false);
                setEditing(undefined);
                const action = leaveAction.current;
                leaveAction.current = null;
                action?.();
              }}
            >
              Discard changes
            </button>
          </div>
        </ModalShell>
      )}
      {deleting && (
        <ModalShell
          title={`Delete “${deleting.source}”?`}
          onClose={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              This permanently removes the glossary term. Translation keys and
              their copy stay available.
            </p>
          </div>
          <div className="dialog-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(
                    `projects/${project.id}/glossary/${deleting.id}?version=${deleting.version}`,
                    { method: "DELETE" },
                  );
                  setDeleting(undefined);
                  setRefresh((value) => value + 1);
                  notify("Glossary term deleted.");
                } catch (error) {
                  setError((error as Error).message);
                  setDeleting(undefined);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete term
            </button>
          </div>
        </ModalShell>
      )}
      {plan && (
        <ModalShell
          title="Import glossary"
          onClose={() => {
            if (!busy) setPlan(undefined);
          }}
          wide
        >
          <div className="dialog-body">
            <p>
              {plan.terms.length} terms · source language{" "}
              {project.sourceLanguage}. New source terms will be added. Existing
              terms and their target wording will be kept.
            </p>
            <p className="muted">
              Each batch of up to 20 terms is atomic. Earlier batches remain
              saved if an import is interrupted. Keep this dialog open to retry
              the same batch.
            </p>
            <ul className="glossary-import-preview">
              {plan.terms.slice(0, 20).map((term) => (
                <li key={termIdentity(term.source)}>
                  <strong>{term.source}</strong>
                  <span>
                    {Object.values(term.translations).filter(Boolean).length}{" "}
                    target terms
                  </span>
                </li>
              ))}
            </ul>
            {plan.terms.length > 20 && (
              <p className="muted">Showing the first 20 terms.</p>
            )}
            <p role="status">
              {plan.index} of {plan.batches.length} batches saved · {plan.added}{" "}
              added · {plan.skipped} existing terms kept
            </p>
            {importError && (
              <div className="error-box" role="alert">
                {importError}
              </div>
            )}
          </div>
          <div className="dialog-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setPlan(undefined)}
            >
              Close
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy
                ? "Importing…"
                : importError
                  ? "Retry import"
                  : "Import terms"}
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
