import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Project, TranslationKey } from "../shared";
import type { EditorHandle } from "./KeyEditor";
import { api, ApiError } from "./api";
import { ModalShell } from "./ui";
import { inlineUpdate } from "./inline-edit";

export default forwardRef<
  EditorHandle,
  {
    project: Project;
    entry: TranslationKey;
    language: string;
    onClose: () => void;
    onSaved: () => Promise<void>;
    onFullEditor: (key: TranslationKey) => void;
    notify: (message: string) => void;
  }
>(function InlineTranslation(
  { project, entry, language, onClose, onSaved, onFullEditor, notify },
  ref,
) {
  const [base, setBase] = useState(entry),
    [text, setText] = useState(entry.translations[language] ?? ""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [pending, setPending] = useState<(() => void) | null>(null);
  const field = useRef<HTMLTextAreaElement>(null),
    saving = useRef(false);
  const original = base.translations[language] ?? "",
    dirty = text !== original || confirmed;
  const outdated = base.outdatedLanguages?.includes(language);
  const locale = project.languages.find((locale) => locale.code === language)!;
  function guard(action: () => void) {
    if (saving.current) return;
    if (dirty) setPending(() => action);
    else action();
  }
  useImperativeHandle(ref, () => ({
    requestClose: () => guard(onClose),
    requestLeave: (action) =>
      guard(() => {
        onClose();
        action();
      }),
  }));
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    field.current?.focus();
    field.current
      ?.closest(".inline-translation")
      ?.scrollIntoView({ block: "nearest" });
    return () => {
      requestAnimationFrame(() => {
        if (
          document.querySelector(".inline-translation textarea, dialog[open]")
        )
          return;
        (opener?.isConnected
          ? opener
          : document.getElementById("key-list-heading")
        )?.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => {
    if (!error) return;
    field.current?.focus();
    field.current
      ?.closest(".inline-translation")
      ?.scrollIntoView({ block: "nearest" });
  }, [error]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  async function save() {
    if (!dirty || saving.current || project.archivedAt) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setConflict(false);
    let saved = false;
    try {
      await api(
        `projects/${project.id}/keys/${encodeURIComponent(base.name)}`,
        {
          method: "PATCH",
          body: JSON.stringify(inlineUpdate(base, language, text)),
        },
      );
      saved = true;
      await onSaved();
      onClose();
      notify(`${locale.name} translation saved.`);
    } catch (error) {
      if (saved) {
        onClose();
        notify("Translation saved. Refresh the list to see the latest data.");
      } else {
        setError((error as Error).message);
        setConflict(error instanceof ApiError && error.status === 409);
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const latest = await api<TranslationKey>(
        `projects/${project.id}/keys/${encodeURIComponent(base.name)}`,
      );
      setBase(latest);
      setText(latest.translations[language] ?? "");
      setConfirmed(false);
      setConflict(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
      requestAnimationFrame(() => field.current?.focus());
    }
  }
  return (
    <div
      className="inline-translation"
      role="group"
      aria-label={`Edit ${locale.name}: ${base.name}`}
    >
      <form
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!saving.current) onClose();
          }
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            void save();
          }
        }}
      >
        <div className="inline-edit-heading">
          <strong>{locale.name}</strong>
          <code>{base.name}</code>
          <span role="status">
            {busy ? "Saving…" : dirty ? "Unsaved" : "Editing"}
          </span>
        </div>
        {language !== project.sourceLanguage && (
          <div className="inline-source">
            <span>Source · {project.sourceLanguage}</span>
            <p dir="auto" lang={project.sourceLanguage}>
              {base.translations[project.sourceLanguage] || "No source copy"}
            </p>
          </div>
        )}
        {base.description && (
          <p className="inline-context">{base.description}</p>
        )}
        <textarea
          ref={field}
          aria-label={`${locale.name} inline translation`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          lang={language}
          dir="auto"
          rows={3}
          maxLength={20000}
          disabled={busy}
        />
        {outdated && text === original && (
          <label className="checkbox-label inline-freshness">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            This translation matches the current source
          </label>
        )}
        {language === project.sourceLanguage && text !== original && (
          <p className="field-warning">
            Changing source copy will mark unchanged target translations
            outdated.
          </p>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
            {conflict && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => guard(() => void reload())}
              >
                Load latest version
              </button>
            )}
          </div>
        )}
        <div className="inline-edit-actions">
          <button
            className="button primary"
            type="submit"
            disabled={busy || !dirty}
          >
            Save
          </button>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => onFullEditor(base)}
          >
            Full editor
          </button>
          <span>Ctrl/⌘ + Enter to save · Esc to cancel</span>
        </div>
      </form>
      {pending && (
        <ModalShell
          title="Discard unsaved changes?"
          subtitle={`${locale.name} · ${base.name}`}
          onClose={() => setPending(null)}
        >
          <div className="dialog-body">
            <p>Your inline draft has not been saved.</p>
          </div>
          <div className="dialog-footer">
            <button className="button" onClick={() => setPending(null)}>
              Keep editing
            </button>
            <button
              className="button danger"
              onClick={() => {
                const action = pending;
                setPending(null);
                action();
              }}
            >
              Discard changes
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
});
