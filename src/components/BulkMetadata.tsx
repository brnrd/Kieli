import { useEffect, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import type { TranslationKey, Project } from "../shared";
import type { MetadataPreview } from "../bulk-metadata";
import { api, ApiError } from "./api";

export default function BulkMetadata({
  project,
  selected,
  onBusyChange,
  onSettled,
  onClose,
}: {
  project: Project;
  selected: TranslationKey[];
  onBusyChange: (busy: boolean) => void;
  onSettled: (processed: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState(() =>
    selected.map(({ name, version }) => ({ name, version })),
  );
  const [addTags, setAddTags] = useState("");
  const [removeTags, setRemoveTags] = useState("");
  const [changeNamespace, setChangeNamespace] = useState(false);
  const [namespace, setNamespace] = useState("");
  const [plan, setPlan] = useState<MetadataPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [page, setPage] = useState(0);
  const [priorProcessed, setPriorProcessed] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [plan?.id, plan?.done, error, page]);
  useEffect(() => {
    if (plan || busy) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [plan?.id, busy]);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  const base = `projects/${project.id}/metadata`;
  function working(value: boolean) {
    setBusy(value);
    onBusyChange(value);
  }
  const split = (text: string) =>
    text
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  async function preview(latest = false) {
    working(true);
    setError("");
    try {
      let keys = plan
        ? plan.entries
            .slice(plan.processed)
            .map(({ name, version }) => ({ name, version }))
        : selection;
      if (latest) {
        const current = [];
        for (const key of keys) {
          const value = await api<TranslationKey>(
            `projects/${project.id}/keys/${encodeURIComponent(key.name)}`,
          );
          current.push({ name: value.name, version: value.version });
        }
        keys = current;
      }
      const result = await api<MetadataPreview>(`${base}/preview`, {
        method: "POST",
        body: JSON.stringify({
          keys,
          operation: {
            addTags: split(addTags),
            removeTags: split(removeTags),
            ...(changeNamespace ? { namespace } : {}),
          },
        }),
      });
      if (plan) setPriorProcessed((count) => count + plan.processed);
      setPlan(result);
      setStale(false);
      setUncertain(false);
      setPage(0);
    } catch (error) {
      setError((error as Error).message);
      if (error instanceof ApiError && [404, 409].includes(error.status))
        setStale(true);
    } finally {
      working(false);
    }
  }
  async function apply() {
    if (!plan) return;
    working(true);
    setError("");
    setUncertain(false);
    let confirmed = plan;
    try {
      // Always reconcile before a retry: an earlier response may have been lost after commit.
      confirmed = await api<MetadataPreview>(`${base}/${plan.id}`);
      setPlan(confirmed);
      while (!confirmed.done) {
        confirmed = await api<MetadataPreview>(`${base}/${plan.id}/apply`, {
          method: "POST",
          body: JSON.stringify({ offset: confirmed.processed }),
        });
        setPlan(confirmed);
      }
    } catch (error) {
      setError((error as Error).message);
      if (error instanceof ApiError && [404, 409, 413].includes(error.status))
        setStale(true);
      try {
        confirmed = await api<MetadataPreview>(`${base}/${plan.id}`);
        setPlan(confirmed);
      } catch {
        setUncertain(true);
      }
    } finally {
      await onSettled(
        confirmed.entries
          .slice(0, confirmed.processed)
          .map((entry) => entry.name),
      );
      working(false);
    }
  }
  async function checkProgress() {
    if (!plan) return;
    working(true);
    try {
      const current = await api<MetadataPreview>(`${base}/${plan.id}`);
      setPlan(current);
      setUncertain(false);
      setError("");
      await onSettled(
        current.entries.slice(0, current.processed).map((entry) => entry.name),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      working(false);
    }
  }
  const entries = plan?.entries.slice(page * 20, page * 20 + 20) ?? [];
  return (
    <>
      <div ref={bodyRef} className="dialog-body bulk-metadata">
        {priorProcessed > 0 && (
          <p className="muted">
            {priorProcessed} keys were processed in earlier previews. Saved
            changes remain applied.
          </p>
        )}
        {!plan && (
          <p>
            {selection.length} selected{" "}
            {selection.length === 1 ? "key" : "keys"} on this page. Change tags
            or namespace; translations and freshness are retained.
          </p>
        )}
        {!plan && (
          <fieldset className="form-fieldset" disabled={busy || !!plan}>
            <div className="field-grid">
              <label className="field-label">
                Add tags
                <input
                  ref={inputRef}
                  autoFocus
                  value={addTags}
                  onChange={(event) => setAddTags(event.target.value)}
                  maxLength={370}
                  placeholder="e.g. checkout, mobile"
                />
                <small>
                  Optional, comma separated. Existing tags are kept.
                </small>
              </label>
              <label className="field-label">
                Remove tags
                <input
                  value={removeTags}
                  onChange={(event) => setRemoveTags(event.target.value)}
                  maxLength={370}
                  placeholder="e.g. legacy"
                />
                <small>
                  Optional, comma separated. Names are case sensitive.
                </small>
              </label>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={changeNamespace}
                onChange={(event) => setChangeNamespace(event.target.checked)}
              />
              Change namespace
            </label>
            {changeNamespace && (
              <label className="field-label">
                New namespace
                <input
                  value={namespace}
                  onChange={(event) => setNamespace(event.target.value)}
                  placeholder="e.g. checkout"
                  maxLength={60}
                  required
                />
                <small>
                  Replaces the namespace on every selected key. Key names stay
                  the same.
                </small>
              </label>
            )}
          </fieldset>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
            {plan && !plan.done && (
              <p>
                Confirmed earlier batches remain saved.{" "}
                {uncertain
                  ? "The latest batch outcome is unknown. Check progress before starting another preview."
                  : "Retry after a connection failure, or preview the remaining keys after a conflict."}
              </p>
            )}
          </div>
        )}
        {plan && !plan.done && (
          <p className="muted">
            Applies up to 10 keys per batch. A failed batch saves no changes;
            earlier batches remain saved.
          </p>
        )}
        {plan && (
          <>
            <p className="metadata-operation-summary">
              {split(addTags).length > 0 && (
                <span>Add tags: {split(addTags).join(", ")}</span>
              )}
              {split(removeTags).length > 0 && (
                <span>Remove tags: {split(removeTags).join(", ")}</span>
              )}
              {changeNamespace && <span>Namespace: {namespace}</span>}
            </p>
            <div className="metadata-summary" role="status" aria-live="polite">
              {plan.done ? (
                <strong>
                  Finished: {plan.updated} updated, {plan.skipped} unchanged.
                </strong>
              ) : (
                <>
                  <strong>
                    {plan.changed} to update · {plan.unchanged} unchanged
                  </strong>
                  <span>
                    {uncertain ? "Last confirmed: " : ""}
                    {plan.processed} of {plan.total} processed · {plan.updated}{" "}
                    updated · {plan.skipped} unchanged
                  </span>
                </>
              )}
              <progress
                aria-label="Bulk metadata progress"
                value={plan.processed}
                max={plan.total}
              />
            </div>
            <div className="metadata-preview-list">
              {entries.map((entry, index) => (
                <article key={entry.name}>
                  <div className="metadata-key-heading">
                    <code>{entry.name}</code>
                    <span>
                      {page * 20 + index < plan.processed
                        ? entry.changed
                          ? "Saved"
                          : "Unchanged"
                        : entry.changed
                          ? "Pending change"
                          : "No change"}
                    </span>
                  </div>
                  {entry.before.namespace !== entry.after.namespace && (
                    <div className="metadata-change">
                      <span>Namespace</span>
                      <code>{entry.before.namespace}</code>
                      <ArrowRight size={13} aria-hidden="true" />
                      <code>{entry.after.namespace}</code>
                    </div>
                  )}
                  {JSON.stringify(entry.before.tags) !==
                    JSON.stringify(entry.after.tags) && (
                    <div className="metadata-change">
                      <span>Tags</span>
                      <span>{entry.before.tags.join(", ") || "None"}</span>
                      <ArrowRight size={13} aria-hidden="true" />
                      <span>{entry.after.tags.join(", ") || "None"}</span>
                    </div>
                  )}
                </article>
              ))}
            </div>
            {plan.total > 20 && (
              <div className="metadata-pagination">
                <button
                  className="button"
                  disabled={busy || page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {page + 1} of {Math.ceil(plan.total / 20)}
                </span>
                <button
                  className="button"
                  disabled={busy || (page + 1) * 20 >= plan.total}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="dialog-footer metadata-footer">
        <button className="button" disabled={busy} onClick={onClose}>
          {plan?.done ? "Done" : "Close"}
        </button>
        {plan && !plan.done && !uncertain && (
          <>
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setSelection(
                  plan.entries
                    .slice(plan.processed)
                    .map(({ name, version }) => ({ name, version })),
                );
                setPriorProcessed((count) => count + plan.processed);
                setPlan(undefined);
                setError("");
                setStale(true);
              }}
            >
              Edit changes
            </button>
            {(stale || plan.processed > 0) && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void preview(true)}
              >
                Preview remaining
              </button>
            )}
          </>
        )}
        {uncertain ? (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void checkProgress()}
          >
            Check progress
          </button>
        ) : !plan ? (
          <button
            className="button primary"
            disabled={
              busy ||
              (!split(addTags).length &&
                !split(removeTags).length &&
                !changeNamespace) ||
              (changeNamespace && !namespace.trim())
            }
            onClick={() => void preview(stale)}
          >
            {busy ? <Loader2 size={15} className="spin" /> : null}Preview
            changes
          </button>
        ) : (
          !plan.done && (
            <button
              className="button primary"
              disabled={busy || stale}
              onClick={() => void apply()}
            >
              {busy ? <Loader2 size={15} className="spin" /> : null}
              {busy
                ? "Applying…"
                : plan.processed
                  ? "Continue"
                  : "Apply changes"}
            </button>
          )
        )}
      </div>
    </>
  );
}
