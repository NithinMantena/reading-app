import { useAuth } from "../auth/AuthProvider";

export function SignIn() {
  const { status, signIn, signOut, error, user } = useAuth();
  return (
    <main className="content">
      <div className="signin">
        <div style={{ fontSize: "3rem" }} aria-hidden>📖</div>
        <h1>Reading</h1>
        <p className="muted">A private reading home: what was read, what to read next, and worthwhile readings from the last day, week, month, year, and decade.</p>
        {status === "unconfigured" && (
          <div className="notice" style={{ textAlign: "left" }}>
            <b>Not configured yet.</b> Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (repository variables for the Pages build, or a local <code>.env</code>), then rebuild. See <code>docs/DEPLOY.md</code>.
          </div>
        )}
        {status === "signed_out" && (
          <button className="btn primary" onClick={() => void signIn()}>Sign in with GitHub</button>
        )}
        {status === "not_owner" && (
          <>
            <div className="notice error" style={{ textAlign: "left" }}>
              Signed in as <b>{String(user?.user_metadata?.user_name ?? user?.email ?? "unknown")}</b>, but this app is private to its owner. The source code is public; the reading data is not.
            </div>
            <button className="btn" onClick={() => void signOut()}>Sign out</button>
          </>
        )}
        {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}
        <p className="small muted" style={{ marginTop: "2rem" }}>
          Source: <a href="https://github.com/NithinMantena/reading-app">github.com/NithinMantena/reading-app</a>
        </p>
      </div>
    </main>
  );
}
