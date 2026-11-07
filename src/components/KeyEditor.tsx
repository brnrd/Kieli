import DuplicateKey from "./DuplicateKey";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight, SkipForward } from "lucide-react";
import type { Project, TranslationKey } from "../shared";
import { api } from "./api";
import KeyForm from "./KeyForm";
import RenameKey from "./RenameKey";
import { ModalShell } from "./ui";
import { isTypingTarget } from "./editor-preferences";
export type EditorFilters = {
  query: string;
  status: string;
  namespace: string;
  language: string;
};
export type EditorHandle = {
  requestClose: () => void;
  requestLeave: (action: () => void) => void;
};
export default forwardRef<
  EditorHandle,
  {
    project: Project;
    initial: TranslationKey | null;
    manager: boolean;
    filters: EditorFilters;
    initialLanguage?: string;
    onSaved: () => Promise<void>;
    onClose: () => void;
    onBusyChange: (busy: boolean) => void;
    notify: (message: string) => void;
  }
>(function KeyEditor(
  {
    project,
    initial,
    manager,
    filters,
    initialLanguage,
    onSaved,
    onClose,
    onBusyChange,
    notify,
  },
  ref,
) {
  const [current, setCurrent] = useState(initial),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState<(() => void) | null>(null);
  const [formGeneration, setFormGeneration] = useState(0);
  const [duplicating, setDuplicating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const actions = useRef({
    move: (_direction: "previous" | "next" | "attention") => {},
  });
  function working(value: boolean) {
    setBusy(value);
    onBusyChange(value);
  }
  function guard(action: () => void) {
    if (busy) return;
    if (dirty) setPending(() => action);
    else action();
  }
  useImperativeHandle(ref, () => ({
    requestClose: () => guard(onClose),
    requestLeave: guard,
  }));
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  async function nextKey(
    direction: "previous" | "next" | "attention",
    anchor = current?.name,
  ) {
    if (!anchor) return;
    const params = new URLSearchParams({
      direction,
      q: filters.query,
      status: filters.status,
      ...(filters.namespace !== "all" ? { namespace: filters.namespace } : {}),
      ...(filters.language !== "all" ? { language: filters.language } : {}),
    });
    const result = await api<{ key: TranslationKey | null }>(
      `projects/${project.id}/keys/${encodeURIComponent(anchor)}/navigation?${params}`,
    );
    if (result.key) {
      setCurrent(result.key);
      setDirty(false);
      setNotice("");
    } else
      setNotice(
        direction === "attention"
          ? "No later keys needing attention match these filters."
          : direction === "previous"
            ? "You’re at the first key matching these filters."
            : "You’re at the last key matching these filters.",
      );
  }
  async function move(direction: "previous" | "next" | "attention") {
    working(true);
    setError("");
    setNotice("");
    try {
      await nextKey(direction);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      working(false);
    }
  }
  actions.current.move = (direction) => guard(() => void move(direction));
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        !current ||
        busy ||
        renaming ||
        pending ||
        event.defaultPrevented ||
        event.isComposing ||
        isTypingTarget(event.target) ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const direction =
        event.key === "ArrowLeft"
          ? "previous"
          : event.key === "ArrowRight"
            ? "next"
            : event.code === "KeyN" || event.key.toLowerCase() === "n"
              ? "attention"
              : undefined;
      if (direction) {
        event.preventDefault();
        actions.current.move(direction);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [current, busy, pending, renaming]);
  async function save(data: Record<string, unknown>, advance = false) {
    working(true);
    setError("");
    setNotice("");
    let saved = false;
    try {
      const result = await api<TranslationKey>(
        `projects/${project.id}/keys${current ? `/${encodeURIComponent(current.name)}` : ""}`,
        { method: current ? "PATCH" : "POST", body: JSON.stringify(data) },
      );
      saved = true;
      setCurrent(result);
      setDirty(false);
      await onSaved();
      notify(current ? "Translations saved." : "New key added.");
      if (advance && current) await nextKey("next", result.name);
      else onClose();
    } catch (error) {
      setError(
        `${saved ? "Changes were saved, but navigation failed. " : ""}${(error as Error).message}`,
      );
    } finally {
      working(false);
    }
  }
  async function reload() {
    if (!current) return;
    working(true);
    setError("");
    try {
      const key = await api<TranslationKey>(
        `projects/${project.id}/keys/${encodeURIComponent(current.name)}`,
      );
      setCurrent(key);
      setDirty(false);
      setFormGeneration((value) => value + 1);
      setNotice("Latest version loaded.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      working(false);
    }
  }
  return (
    <>
      {current && (
        <div className="editor-navigation">
          <strong className="editor-current-key">{current.name}</strong>
          <div
            className="editor-navigation-actions"
            aria-label="Key navigation"
          >
            <button
              type="button"
              className="button"
              disabled={busy}
              title="Previous key · Alt + Left Arrow outside text fields"
              onClick={() => guard(() => void move("previous"))}
            >
              <ChevronLeft size={15} />
              Previous key
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              title="Next key · Alt + Right Arrow outside text fields"
              onClick={() => guard(() => void move("next"))}
            >
              Next key
              <ChevronRight size={15} />
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              title="Next needing attention · Alt + N outside text fields"
              onClick={() => guard(() => void move("attention"))}
            >
              <SkipForward size={15} />
              Next needing attention
            </button>
          </div>
          <p>
            Within your current filters
            {filters.language === "all"
              ? " · all languages"
              : ` · ${filters.language}`}
            . Navigation continues across pages.
          </p>
          <details className="editor-shortcuts">
            <summary>Keyboard shortcuts</summary>
            <p>
              <kbd>Alt + ←</kbd> Previous · <kbd>Alt + →</kbd> Next ·{" "}
              <kbd>Alt + N</kbd> Next needing attention. Shortcuts work outside
              text fields; use Tab to reach the controls.
            </p>
          </details>
          {notice && (
            <p role="status" className="editor-notice">
              {notice}
            </p>
          )}
        </div>
      )}
      <KeyForm
        key={`${current?.name ?? "new"}:${current?.version ?? 0}:${formGeneration}`}
        project={project}
        editing={current}
        manager={manager}
        busy={busy}
        error={error}
        focusLanguage={initialLanguage ?? filters.language}
        onDirtyChange={setDirty}
        onSubmit={(data, advance) => void save(data, advance)}
        onDuplicate={() =>
          guard(() => {
            setDirty(false);
            setFormGeneration((value) => value + 1);
            setDuplicating(true);
          })
        }
        onRename={() =>
          guard(() => {
            setDirty(false);
            setFormGeneration((value) => value + 1);
            setRenaming(true);
          })
        }
        onClose={() => guard(onClose)}
        onReload={async () => guard(() => void reload())}
        onRestored={async () => {
          await onSaved();
          onClose();
          notify("Translation restored.");
        }}
      />
      {duplicating && current && (
        <DuplicateKey
          project={project}
          editing={current}
          onClose={() => setDuplicating(false)}
          onBusyChange={working}
          onCreated={async (key) => {
            setCurrent(key);
            setDirty(false);
            setDuplicating(false);
            await onSaved();
            notify("Key duplicated.");
          }}
        />
      )}
      {renaming && current && (
        <RenameKey
          project={project}
          editing={current}
          onClose={() => setRenaming(false)}
          onBusyChange={working}
          onRenamed={async (key) => {
            setCurrent(key);
            setDirty(false);
            setRenaming(false);
            await onSaved();
            notify("Key renamed and references updated.");
          }}
        />
      )}
      {pending && (
        <ModalShell
          title="Discard unsaved changes?"
          subtitle="Your current draft has not been saved."
          onClose={() => setPending(null)}
        >
          <div className="dialog-body">
            <p>Keep editing to save your draft, or discard it to continue.</p>
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
    </>
  );
});
