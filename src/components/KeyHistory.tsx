import { useState } from "react";
import type { Project, TranslationKey } from "../shared";
import type { KeyEdit } from "../server/key-history";
import { api } from "./api";
export default function KeyHistory({
  project,
  editing,
  manager,
  onRestored,
}: {
  project: Project;
  editing: TranslationKey;
  manager: boolean;
  onRestored: () => Promise<void>;
}) {
  const [items, setItems] = useState<KeyEdit[]>([]),
    [cursor, setCursor] = useState<string>(),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [language, setLanguage] = useState(
      project.languages.find((locale) => locale.code !== project.sourceLanguage)
        ?.code ?? project.sourceLanguage,
    ),
    [confirm, setConfirm] = useState<{
      entry: KeyEdit;
      side: "before" | "after";
    }>();
  const base = `projects/${project.id}/keys/${encodeURIComponent(editing.name)}/history`;
  async function load(more = false) {
    setBusy(true);
    setError("");
    try {
      const page = await api<{ items: KeyEdit[]; nextCursor?: string }>(
        `${base}${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
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
      className="key-history"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !busy) void load();
      }}
    >
      <summary>Translation history</summary>
      <p className="muted">
        History starts when this feature was installed. Restore one language
        without replacing other copy.
      </p>
      <label className="field-label">
        Language
        <select
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value);
            setConfirm(undefined);
          }}
        >
          {project.languages.map((locale) => (
            <option key={locale.code} value={locale.code}>
              {locale.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {loaded && !items.length && (
        <p className="muted">No recorded changes for this key yet.</p>
      )}
      {items.map((entry) => (
        <article className="key-history-entry" key={entry.id}>
          <div className="history-entry-heading">
            <strong>{entry.actorName}</strong>
            <span>
              {entry.origin} · {new Date(entry.at).toLocaleString()}
              {entry.before &&
                entry.after &&
                entry.before.name !== entry.after.name &&
                ` · Renamed ${entry.before.name} → ${entry.after.name}`}
              {entry.before &&
              entry.after &&
              entry.before.translations[project.sourceLanguage] !==
                entry.after.translations[project.sourceLanguage]
                ? " · Source changed"
                : ""}
            </span>
          </div>
          <div className="history-diff">
            <div>
              <small>Before</small>
              <pre>{entry.before?.translations[language] ?? "(empty)"}</pre>
              {entry.before &&
                Object.hasOwn(entry.before.translations, language) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      busy || (!manager && language === project.sourceLanguage)
                    }
                    onClick={() => setConfirm({ entry, side: "before" })}
                  >
                    Restore previous text
                  </button>
                )}
            </div>
            <div>
              <small>After</small>
              <pre>{entry.after?.translations[language] ?? "(empty)"}</pre>
              {entry.after &&
                Object.hasOwn(entry.after.translations, language) && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      busy || (!manager && language === project.sourceLanguage)
                    }
                    onClick={() => setConfirm({ entry, side: "after" })}
                  >
                    Restore this version
                  </button>
                )}
            </div>
          </div>
        </article>
      ))}
      {confirm && (
        <div className="info-note history-restore-confirm">
          <div>
            <strong>
              Restore{" "}
              {
                project.languages.find((locale) => locale.code === language)
                  ?.name
              }
              ?
            </strong>
            <p>
              This closes the editor and discards unsaved edits. Older text
              keeps its original source context and may remain outdated.
            </p>
            <pre>{confirm.entry[confirm.side]?.translations[language]}</pre>
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
                void api(
                  `${base}/${encodeURIComponent(confirm.entry.id)}/restore`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      version: editing.version,
                      language,
                      side: confirm.side,
                      expectedSourceContext: editing.sourceContext,
                    }),
                  },
                )
                  .then(onRestored)
                  .catch((error) => setError(error.message))
                  .finally(() => setBusy(false));
              }}
            >
              Restore translation
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
          Load older changes
        </button>
      )}
      {busy && <p role="status">Loading…</p>}
    </details>
  );
}
