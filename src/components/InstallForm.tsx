import { useState, type SyntheticEvent } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

export default function InstallForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, token, password }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Unable to complete installation.");
      setToken("");
      setPassword("");
      setConfirmation("");
      window.location.assign("/");
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  return (
    <form
      className="sign-in-form install-form"
      onSubmit={submit}
      method="POST"
      action="/api/auth/install"
    >
      <fieldset className="form-fieldset" disabled={busy}>
        <label className="field-label">
          AWS setup secret
          <input
            type="password"
            name="token"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value.trim())}
            required
            minLength={48}
            maxLength={48}
            spellCheck={false}
          />
          <span>
            In your stack's Outputs, open SetupSecretConsole. Retrieve the
            secret and copy its <code>token</code> value. This is used only for
            this installation.
          </span>
        </label>
        <div className="install-fields">
          <label className="field-label">
            Your name
            <input
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
            />
          </label>
          <label className="field-label">
            Admin email
            <input
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
            />
          </label>
        </div>
        <label className="field-label">
          Choose a password
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={15}
            maxLength={128}
          />
          <span>
            15–128 characters. Use a unique passphrase or password manager.
          </span>
        </label>
        <label className="field-label">
          Confirm password
          <input
            type="password"
            name="confirmation"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            minLength={15}
            maxLength={128}
          />
        </label>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <button
          className="button primary login-button"
          disabled={busy}
          type="submit"
        >
          {busy ? (
            <Loader2 className="spin" size={17} />
          ) : (
            <ShieldCheck size={17} />
          )}
          <span>Create admin & open workspace</span>
        </button>
        <p className="login-help">
          Your account manages this installation. Invite teammates and configure
          project access after signing in.
        </p>
      </fieldset>
    </form>
  );
}
