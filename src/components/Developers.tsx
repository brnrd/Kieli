import { useState, useEffect, type SyntheticEvent } from "react";
import {
  Code2,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { AuthMode, Project } from "../shared";
import SyncConnection from "./SyncConnection";
import McpConnection from "./McpConnection";
import { IconButton, ModalShell } from "./ui";
import { api } from "./api";
import FileFormatSelect from "./FileFormatSelect";
import OtaDelivery from "./OtaDelivery";
type TokenInfo = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string;
};
export default function Developers({
  project,
  manager,
  authMode,
  notify,
}: {
  project: Project;
  manager: boolean;
  authMode: AuthMode;
  notify: (message: string) => void;
}) {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revoke, setRevoke] = useState<TokenInfo | null>(null);
  const [origin, setOrigin] = useState("https://keylo.example.com");
  const [format, setFormat] = useState("flat");
  useEffect(() => {
    setOrigin(window.location.origin);
    if (manager)
      void api<TokenInfo[]>(`projects/${project.id}/tokens`)
        .then(setTokens)
        .catch((e) => setError(e.message));
  }, [project.id, manager]);
  const command = `node cli/keylo.mjs pull \\\n  --url ${origin} \\\n  --project ${project.id} \\\n  --format ${format} \\\n  --out ./locales`;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied to clipboard.");
    } catch {
      setError("Clipboard is unavailable. Select and copy the text instead.");
    }
  }
  async function create(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ secret: string }>(
        `projects/${project.id}/tokens`,
        { method: "POST", body: JSON.stringify({ name, expiresInDays: days }) },
      );
      setSecret(data.secret);
      setName("");
      setTokens(await api(`projects/${project.id}/tokens`));
      notify("Export token created. Copy it now; it is only shown once.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revokeToken() {
    if (!revoke) return;
    setBusy(true);
    setError("");
    try {
      await api(`projects/${project.id}/tokens/${revoke.id}`, {
        method: "DELETE",
      });
      setTokens((t) => t.filter((token) => token.id !== revoke.id));
      setRevoke(null);
      notify("Token revoked.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="developers-page">
      <div className="developer-intro">
        <span className="eyebrow">FROM COPY TO CODE</span>
        <h2>Fits right into your flow.</h2>
        <p>
          Pull translation files into your build, or publish copy to live apps.
        </p>
      </div>
      <div className="developer-format">
        <FileFormatSelect value={format} onChange={setFormat} />
      </div>
      <div className="developer-grid">
        <div className="code-card">
          <div className="code-card-header">
            <Terminal size={16} />
            <strong>A command. All your languages.</strong>
            <IconButton
              label="Copy CLI command"
              onClick={() => void copy(command)}
            >
              <Copy size={15} />
            </IconButton>
          </div>
          <pre>
            <code>{command}</code>
          </pre>
          <div className="code-card-footer">
            <span className="status-dot" />
            Set <code>KEYLO_TOKEN</code> in your shell or CI secrets.
          </div>
        </div>
        <div className="developer-detail">
          <span className="detail-icon">
            <Code2 size={22} />
          </span>
          <h3>Small API. Many possibilities.</h3>
          <p>
            Export your chosen localization format, with optional
            source-language fallback. Export tokens are read-only and scoped to
            this project.
          </p>
          <code>GET /api/projects/{project.id}/export</code>
          <button
            className="text-button"
            onClick={() =>
              void copy(
                `curl --fail --header "Authorization: Bearer $KEYLO_TOKEN" "${origin}/api/projects/${project.id}/export?format=${format}&download=zip" --output translations.zip`,
              )
            }
          >
            Copy cURL example
            <Copy size={13} />
          </button>
        </div>
      </div>
      <div className="section-title standalone">
        <div>
          <h2>Export tokens</h2>
          <p>A small key to your translations. Store it somewhere safe.</p>
        </div>
        <span className="read-only-pill">
          <ShieldCheck size={13} />
          READ ONLY
        </span>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {manager ? (
        <>
          <form className="token-form" onSubmit={create}>
            <label className="field-label">
              Token name
              <input
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. GitHub Actions — production"
                disabled={busy}
              />
            </label>
            <label className="field-label">
              Expires in
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                disabled={busy}
              >
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>1 year</option>
              </select>
            </label>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Plus size={16} />
              )}
              Create token
            </button>
          </form>
          {secret && (
            <div className="secret-box" role="status">
              <div>
                <KeyRound size={16} />
                <strong>Copy this token now. It is shown only once.</strong>
                <IconButton label="Hide token" onClick={() => setSecret("")}>
                  <X size={15} />
                </IconButton>
              </div>
              <div>
                <code>{secret}</code>
                <IconButton
                  label="Copy export token"
                  onClick={() => void copy(secret)}
                >
                  <Copy size={16} />
                </IconButton>
              </div>
            </div>
          )}
          {tokens.length ? (
            <div className="token-list">
              {tokens.map((t) => (
                <div className="token-row" key={t.id}>
                  <span className="token-icon">
                    <KeyRound size={17} />
                  </span>
                  <div>
                    <strong>{t.name}</strong>
                    <code>{t.prefix}…</code>
                  </div>
                  <span
                    className={
                      new Date(t.expiresAt).getTime() < Date.now()
                        ? "danger-text"
                        : "muted"
                    }
                  >
                    {new Date(t.expiresAt).getTime() < Date.now()
                      ? "Expired"
                      : "Expires"}{" "}
                    {new Date(t.expiresAt).toLocaleDateString("en-GB")}
                  </span>
                  <IconButton
                    label={`Revoke ${t.name}`}
                    onClick={() => setRevoke(t)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              ))}
            </div>
          ) : (
            <div className="subtle-empty">
              <KeyRound size={19} />
              <p>No export tokens yet. Create one for your app or pipeline.</p>
            </div>
          )}
        </>
      ) : (
        <div className="info-note">
          <ShieldCheck size={20} />
          <p>
            A project manager can create an export token for your integration.
          </p>
        </div>
      )}
      <div className="info-note">
        <Terminal size={20} />
        <p>
          In CI, pull translations before your build step. The CLI exits with a
          nonzero status on errors and writes locale files atomically. Add{" "}
          <code>--format nested</code> or <code>--languages fr,nl</code> to
          tailor your export.
        </p>
      </div>
      {revoke && (
        <ModalShell
          title={`Revoke “${revoke.name}”?`}
          subtitle="Any integration using this token will immediately lose access. You can create a replacement anytime."
          onClose={() => {
            if (!busy) setRevoke(null);
          }}
        >
          <div className="dialog-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setRevoke(null)}
            >
              Keep token
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void revokeToken()}
            >
              {busy && <Loader2 className="spin" size={15} />}Revoke token
            </button>
          </div>
        </ModalShell>
      )}
      <SyncConnection project={project} manager={manager} notify={notify} />
      {manager && <OtaDelivery project={project} notify={notify} />}
      <McpConnection
        key={project.id}
        project={project}
        manager={manager}
        authMode={authMode}
        notify={notify}
      />
    </div>
  );
}
