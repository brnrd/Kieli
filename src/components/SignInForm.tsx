import { useEffect, useState, type SyntheticEvent } from "react";
import { Eye, EyeOff, Loader2, LogIn, ShieldCheck } from "lucide-react";

export default function SignInForm({
  setup = false,
  token = "",
}: {
  setup?: boolean;
  token?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (setup && token) window.history.replaceState({}, "", "/auth/setup");
  }, []);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (setup && password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    if (setup && !token) {
      setError(
        "Reopen the activation or reset link supplied by your administrator.",
      );
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/auth/${setup ? "activate" : "login"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            setup ? { token, password } : { email, password },
          ),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Unable to sign in. Please try again.");
      window.location.assign("/");
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  return (
    <form
      method="POST"
      action={`/api/auth/${setup ? "activate" : "login"}`}
      className="sign-in-form"
      onSubmit={submit}
    >
      <fieldset className="form-fieldset" disabled={busy}>
        {!setup && (
          <label className="field-label">
            Email address
            <input
              type="email"
              autoComplete="username"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
              required
              maxLength={254}
            />
          </label>
        )}
        <label className="field-label">
          {setup ? "Choose a password" : "Password"}
          <div className="password-input">
            <input
              name="password"
              type={visible ? "text" : "password"}
              autoComplete={setup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={setup ? 15 : undefined}
              maxLength={128}
              required
              autoFocus={setup}
            />
            <button
              type="button"
              aria-label={visible ? "Hide password" : "Show password"}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {setup && (
            <span>
              15–128 characters. Use a unique passphrase or password manager.
            </span>
          )}
        </label>
        {setup && (
          <label className="field-label">
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              name="confirmation"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              required
              minLength={15}
              maxLength={128}
            />
          </label>
        )}
        {error && (
          <div role="alert" className="error-box">
            {error}
          </div>
        )}
        <button
          className="button primary login-button"
          type="submit"
          disabled={busy || (setup && !token)}
        >
          {busy ? (
            <Loader2 size={17} className="spin" />
          ) : setup ? (
            <ShieldCheck size={17} />
          ) : (
            <LogIn size={17} />
          )}
          <span>{setup ? "Set password & continue" : "Sign in"}</span>
        </button>
        {!setup && (
          <p className="login-help">
            Need an account or password reset? Ask your workspace administrator
            for a one-time link.
          </p>
        )}
      </fieldset>
    </form>
  );
}
