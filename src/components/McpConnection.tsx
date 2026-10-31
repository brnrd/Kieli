import { useEffect, useState, type SyntheticEvent } from "react";
import { Bot, Copy, KeyRound, Loader2, Plus, Trash2, X } from "lucide-react";
import type { AuthMode, McpTokenView, Project } from "../shared";
import { api } from "./api";
import { IconButton, ModalShell } from "./ui";

export default function McpConnection({
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
  const targets = project.languages.filter(
    (l) => l.code !== project.sourceLanguage,
  );
  const [languages, setLanguages] = useState(targets.map((l) => l.code));
  const [name, setName] = useState("Claude Code");
  const [days, setDays] = useState(7);
  const [overwrite, setOverwrite] = useState(false);
  const [tokens, setTokens] = useState<McpTokenView[]>([]);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revoke, setRevoke] = useState<McpTokenView | null>(null);
  const [origin, setOrigin] = useState("https://keylo.example.com");
  const path = `projects/${project.id}/mcp-tokens`;
  const sso = authMode === "okta" || authMode === "saml";
  useEffect(() => {
    setOrigin(window.location.origin);
    if (manager)
      void api<McpTokenView[]>(path)
        .then(setTokens)
        .catch((e) => setError(e.message));
  }, [path, manager]);
  const configuration = JSON.stringify(
    {
      mcpServers: {
        keylo: {
          type: "http",
          url: `${origin}/mcp`,
          headers: { Authorization: "Bearer ${KEYLO_MCP_TOKEN}" },
        },
      },
    },
    null,
    2,
  );
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied to clipboard.");
    } catch {
      setError("Clipboard is unavailable. Select and copy the text instead.");
    }
  }
  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ secret: string; credential: McpTokenView }>(
        path,
        {
          method: "POST",
          body: JSON.stringify({
            name,
            languages,
            expiresInDays: days,
            allowOverwrite: overwrite,
          }),
        },
      );
      setSecret(data.secret);
      setTokens((current) => [...current, data.credential]);
      notify("MCP credential created. Copy it now; it is shown only once.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!revoke) return;
    setBusy(true);
    setError("");
    try {
      await api(`${path}/${revoke.id}`, { method: "DELETE" });
      setTokens((current) => current.filter((token) => token.id !== revoke.id));
      setRevoke(null);
      notify("MCP connection revoked.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mcp-section" aria-labelledby="mcp-title">
      <div className="section-title standalone">
        <div>
          <h2 id="mcp-title">
            <Bot size={19} /> Claude Code
          </h2>
          <p>Read project context and save translations through MCP.</p>
        </div>
        <span className="read-only-pill">TARGET LANGUAGES ONLY</span>
      </div>
      <div className="mcp-setup">
        <div className="code-card">
          <div className="code-card-header">
            <strong>.mcp.json</strong>
            <IconButton
              label="Copy MCP configuration"
              onClick={() => void copy(configuration)}
            >
              <Copy size={15} />
            </IconButton>
          </div>
          <pre>
            <code>{configuration}</code>
          </pre>
        </div>
        <div className="mcp-instructions">
          <ol>
            <li>
              Save this configuration as <code>.mcp.json</code> in your code
              repository. Merge it with existing MCP servers.
            </li>
            <li>
              Set <code>KEYLO_MCP_TOKEN</code> securely in the environment that
              launches Claude Code.
            </li>
            <li>
              Restart Claude Code, approve this server, and check{" "}
              <code>/mcp</code>.
            </li>
          </ol>
          <p className="muted">
            Try: “Translate missing French copy in Keylo. Preserve placeholders
            and save the translations.”
          </p>
          <p className="muted">
            Claude receives the copy it reads. Your selected languages limit
            writes; source copy and key details stay protected.
          </p>
        </div>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {manager ? (
        <>
          <form className="mcp-form" onSubmit={create}>
            <div className="mcp-form-fields">
              <label className="field-label">
                Connection name
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </label>
              {!sso && (
                <label className="field-label">
                  Expires in
                  <select
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                    disabled={busy}
                  >
                    <option value={1}>1 day</option>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                  </select>
                </label>
              )}
              <button
                className="button primary"
                type="submit"
                disabled={busy || !languages.length}
              >
                {busy ? (
                  <Loader2 className="spin" size={15} />
                ) : (
                  <Plus size={15} />
                )}
                Create MCP credential
              </button>
            </div>
            <fieldset disabled={busy} className="mcp-languages">
              <legend>Allowed target languages</legend>
              {targets.map((language) => (
                <label key={language.code}>
                  <input
                    type="checkbox"
                    checked={languages.includes(language.code)}
                    onChange={(event) =>
                      setLanguages((current) =>
                        event.target.checked
                          ? [...current, language.code]
                          : current.filter((code) => code !== language.code),
                      )
                    }
                  />
                  {language.name}
                  <code>{language.code}</code>
                </label>
              ))}
              {!targets.length && (
                <p className="muted">
                  Add a target language in project settings first.
                </p>
              )}
            </fieldset>
            <label className="mcp-overwrite">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                disabled={busy}
              />
              Allow replacing existing target translations
            </label>
            <p className="muted mcp-policy">
              Fills missing translations by default. Replacements also require
              an explicit overwrite request from Claude.{" "}
              {sso
                ? "SSO credentials expire at this sign-in's absolute expiry, within one hour. Revoke the connection separately when signing out."
                : authMode === "demo"
                  ? "Demo credentials work only on loopback, outside production."
                  : "Access is tied to the creator. Account deactivation, access changes, or revoking all sessions invalidate local-account credentials."}
            </p>
          </form>
          {secret && (
            <div className="secret-box" role="status">
              <div>
                <KeyRound size={16} />
                <strong>
                  Copy this MCP credential now. It is shown only once.
                </strong>
                <IconButton
                  label="Hide MCP credential"
                  onClick={() => setSecret("")}
                >
                  <X size={15} />
                </IconButton>
              </div>
              <div>
                <code>{secret}</code>
                <IconButton
                  label="Copy MCP credential"
                  onClick={() => void copy(secret)}
                >
                  <Copy size={16} />
                </IconButton>
              </div>
            </div>
          )}
          {tokens.length ? (
            <div className="token-list">
              {tokens.map((token) => (
                <div className="token-row mcp-token-row" key={token.id}>
                  <span className="token-icon">
                    <Bot size={17} />
                  </span>
                  <div>
                    <strong>{token.name}</strong>
                    <span className="mcp-token-meta">
                      {token.createdByName} · {token.languages.join(", ")} ·{" "}
                      {token.allowOverwrite ? "Can replace" : "Fill missing"}
                    </span>
                    <code>{token.prefix}…</code>
                  </div>
                  <div className="mcp-token-dates">
                    <span
                      className={
                        Date.parse(token.expiresAt) <= Date.now()
                          ? "danger-text"
                          : "muted"
                      }
                    >
                      {Date.parse(token.expiresAt) <= Date.now()
                        ? "Expired"
                        : "Expires"}{" "}
                      {new Date(token.expiresAt).toLocaleString("en-GB", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </span>
                    <span className="muted">
                      {token.lastUsedAt
                        ? `Last used ${new Date(token.lastUsedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}`
                        : "Never used"}
                    </span>
                  </div>
                  <IconButton
                    label={`Revoke MCP connection ${token.name}`}
                    onClick={() => setRevoke(token)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              ))}
            </div>
          ) : (
            <div className="subtle-empty">
              <Bot size={19} />
              <p>No MCP connections yet.</p>
            </div>
          )}
        </>
      ) : (
        <div className="info-note">
          <Bot size={20} />
          <p>A project manager can create a Claude Code connection.</p>
        </div>
      )}
      {revoke && (
        <ModalShell
          title={`Revoke “${revoke.name}”?`}
          subtitle="Claude Code will lose access on its next request. Requests already in progress may finish."
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
              Keep connection
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy && <Loader2 className="spin" size={15} />}Revoke connection
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
