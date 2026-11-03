import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import type { Identity } from "../shared";
import { api } from "./api";
import { ModalShell } from "./ui";
type User = {
  id: string;
  name: string;
  email: string;
  userName: string;
  active: boolean;
  blocked: boolean;
  managed: boolean;
  version: number;
};
type Listing = {
  items: User[];
  next?: string;
  mode: string;
  reconciliationConfigured: boolean;
  reconciliation?: {
    lastRun: string;
    lastCompleteCycle?: string;
    failures: number;
  };
};
export default function SsoUserManagement({
  identity,
  embedded = false,
  notify,
}: {
  identity: Identity;
  embedded?: boolean;
  notify: (message: string) => void;
}) {
  const Heading = embedded ? "h2" : "h1";
  const [listing, setListing] = useState<Listing>(),
    [query, setQuery] = useState(""),
    [after, setAfter] = useState(""),
    [pages, setPages] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<{
      user: User;
      action: "block" | "unblock" | "revoke" | "reactivate";
    }>();
  const load = () =>
    api<Listing>(
      `sso/users?limit=50&after=${encodeURIComponent(after)}&q=${encodeURIComponent(query)}`,
    ).then(setListing);
  useEffect(() => {
    let current = true;
    void api<Listing>(
      `sso/users?limit=50&after=${encodeURIComponent(after)}&q=${encodeURIComponent(query)}`,
    )
      .then((value) => {
        if (current) {
          setListing(value);
          setError("");
        }
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [query, after]);
  return (
    <section className="account-page">
      <div className="page-heading">
        <div>
          <Heading>People &amp; access</Heading>
          <p>
            SSO groups manage project roles. Block access or revoke a person's
            Kieli sessions and personal connections here.
          </p>
        </div>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="info-note">
        <ShieldCheck size={18} />
        <p>
          {listing?.mode === "scim"
            ? "SCIM provisioning is enabled. Users must be provisioned before signing in."
            : "Users appear after their first SSO sign-in."}{" "}
          {listing?.reconciliationConfigured
            ? `Okta reconciliation: ${listing.reconciliation?.lastRun ? `last run ${new Date(listing.reconciliation.lastRun).toLocaleString()}${listing.reconciliation.failures ? " · failures need attention" : ""}` : "waiting for its first run"}.`
            : "Okta reconciliation is not configured."}
        </p>
      </div>
      <label className="field-label">
        Find a person
        <input
          type="search"
          value={query}
          maxLength={200}
          onChange={(event) => {
            setQuery(event.target.value);
            setAfter("");
            setPages([]);
          }}
          placeholder="Name or email"
        />
      </label>
      <div className="history-list">
        {listing?.items.map((user) => (
          <div className="history-row" key={user.id}>
            <div>
              <strong>
                {user.name || user.userName}
                {user.id === identity.principalId ? " · You" : ""}
              </strong>
              <span>
                {user.email || user.userName} ·{" "}
                {user.blocked
                  ? "Blocked in Kieli"
                  : user.active
                    ? "Active"
                    : "Deactivated"}{" "}
                · {user.managed ? "SCIM" : "SSO sign-in"}
              </span>
            </div>
            <div className="history-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setConfirm({ user, action: "revoke" })}
              >
                Revoke sessions
              </button>
              {!user.active && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => setConfirm({ user, action: "reactivate" })}
                >
                  Reactivate
                </button>
              )}
              <button
                className="button"
                disabled={
                  busy || (!user.blocked && user.id === identity.principalId)
                }
                onClick={() =>
                  setConfirm({
                    user,
                    action: user.blocked ? "unblock" : "block",
                  })
                }
              >
                {user.blocked ? "Unblock" : "Block"}
              </button>
            </div>
          </div>
        ))}
      </div>
      {listing && !listing.items.length && (
        <p className="muted">No matching SSO users.</p>
      )}
      <div className="pagination">
        <button
          className="button"
          disabled={!pages.length || busy}
          onClick={() => {
            setAfter(pages.at(-1)!);
            setPages(pages.slice(0, -1));
          }}
        >
          Previous
        </button>
        <button
          className="button"
          disabled={!listing?.next || busy}
          onClick={() => {
            setPages([...pages, after]);
            setAfter(listing!.next!);
          }}
        >
          Next
        </button>
      </div>
      {confirm && (
        <ModalShell
          title={
            confirm.action === "revoke"
              ? "Revoke sessions and connections?"
              : confirm.action === "reactivate"
                ? "Reactivate this account?"
                : confirm.action === "block"
                  ? "Block this account?"
                  : "Unblock this account?"
          }
          subtitle={confirm.user.name || confirm.user.userName}
          onClose={() => {
            if (!busy) setConfirm(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              {confirm.action === "revoke"
                ? "Existing Kieli sessions and personal MCP credentials will stop working. The person can sign in again if their account and SSO assignment remain active."
                : confirm.action === "block"
                  ? "This blocks Kieli access, including future SSO sign-ins, and invalidates existing sessions and personal MCP credentials. Translation contributions are retained."
                  : "Confirm that this person should have access again. Current SSO provisioning and group assignments still determine their project permissions. Existing revoked credentials stay invalid."}
            </p>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="dialog-footer">
            <button
              className="button"
              disabled={busy}
              onClick={() => setConfirm(undefined)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api(`sso/users/${confirm.user.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    version: confirm.user.version,
                    action: confirm.action,
                  }),
                })
                  .then(async () => {
                    if (
                      confirm.user.id === identity.principalId &&
                      confirm.action === "revoke"
                    ) {
                      window.location.assign("/login");
                      return;
                    }
                    setConfirm(undefined);
                    await load();
                    notify("SSO access updated.");
                  })
                  .catch((error) => setError(error.message))
                  .finally(() => setBusy(false));
              }}
            >
              {busy && <Loader2 className="spin" size={14} />}Confirm
            </button>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
