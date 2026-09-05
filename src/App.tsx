import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { SignIn } from "./views/SignIn";
import { Onboarding } from "./views/Onboarding";
import { Home } from "./views/Home";
import { Library } from "./views/Library";
import { BookDetail } from "./views/BookDetail";
import { Discover } from "./views/Discover";
import { Queue } from "./views/Queue";
import { Preferences } from "./views/Preferences";

export default function App() {
  const { status, settings } = useAuth();

  if (status === "unconfigured" || status === "signed_out" || status === "not_owner") return <SignIn />;
  if (status === "loading" || !settings) {
    return (
      <main className="content">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (!settings.onboarding_complete) return <Onboarding />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="library" element={<Library />} />
        <Route path="library/:id" element={<BookDetail />} />
        <Route path="discover" element={<Discover />} />
        <Route path="discover/:horizon" element={<Discover />} />
        <Route path="queue" element={<Queue />} />
        <Route path="queue/:id" element={<Queue />} />
        <Route path="preferences" element={<Preferences />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
