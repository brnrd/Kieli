import { useState, type SyntheticEvent } from "react";
import { Check, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import type { AuthMode, Identity } from "../shared";
import { api } from "./api";

export default function Account({
  identity,
  mode,
  notify,
}: {
  identity: Identity;
  mode: AuthMode;
  notify: (message: string) => void;
}) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (confirmation !== newPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await api("auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrent("");
      setNew("");
      setConfirmation("");
      notify("Password changed. Other sessions have been signed out.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="account-page">
      <div className="page-heading">
        <div>
          <h1>Your account</h1>
          <p>Your identity and sign-in settings.</p>
        </div>
      </div>
      <div className="account-details">
        <div>
          <span>Name</span>
          <strong>{identity.name}</strong>
        </div>
        <div>
          <span>Email</span>
          <strong>{identity.email}</strong>
        </div>
        <div>
          <span>Workspace role</span>
          <span className="role-pill">
            {identity.admin ? "Admin" : "Member"}
          </span>
        </div>
        <div>
          <span>Sign-in method</span>
          <strong>
            {mode === "local"
              ? "Email and password"
              : mode === "okta"
                ? "Okta SSO"
                : mode === "saml"
                  ? "SAML SSO"
                  : "Local demo"}
          </strong>
        </div>
      </div>
      {mode === "local" ? (
        <form
          className="password-change-form settings-form"
          method="POST"
          action="/api/auth/password"
          onSubmit={submit}
        >
          <fieldset className="form-fieldset" disabled={busy}>
            <div className="dialog-body">
              <h2>
                <LockKeyhole size={18} />
                Change password
              </h2>
              <p>Updating your password signs out your other sessions.</p>
              <label className="field-label">
                Current password
                <input
                  type="password"
                  name="currentPassword"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={currentPassword}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </label>
              <label className="field-label">
                New password
                <input
                  type="password"
                  name="newPassword"
                  autoComplete="new-password"
                  required
                  minLength={15}
                  maxLength={128}
                  value={newPassword}
                  onChange={(e) => setNew(e.target.value)}
                />
                <span>
                  15–128 characters. Choose a unique passphrase or use a
                  password manager.
                </span>
              </label>
              <label className="field-label">
                Confirm new password
                <input
                  type="password"
                  name="confirmation"
                  autoComplete="new-password"
                  required
                  minLength={15}
                  maxLength={128}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
              {error && (
                <div className="error-box" role="alert">
                  {error}
                </div>
              )}
            </div>
            <div className="dialog-footer">
              <button type="submit" className="button primary">
                {busy ? (
                  <Loader2 className="spin" size={15} />
                ) : (
                  <Check size={15} />
                )}
                Update password
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        <div className="info-note">
          <ShieldCheck size={19} />
          <p>
            {mode === "okta" || mode === "saml"
              ? "Your password and MFA are managed by your identity provider. Contact your organization to update sign-in settings."
              : "The demo uses a development identity. Enable built-in accounts with AUTH_MODE=local."}
          </p>
        </div>
      )}
    </section>
  );
}
