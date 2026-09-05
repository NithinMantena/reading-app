import { NavLink, Link, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

const links = [
  { to: "/", label: "Home", end: true },
  { to: "/library", label: "Library" },
  { to: "/discover", label: "Discover" },
  { to: "/queue", label: "Reading queue" },
  { to: "/preferences", label: "Preferences" },
];

export function Layout() {
  const { user, signOut } = useAuth();
  const avatar = (user?.user_metadata?.avatar_url as string | undefined) ?? undefined;
  const name = (user?.user_metadata?.user_name as string | undefined) ?? user?.email ?? "";
  return (
    <>
      <header className="app-header">
        <div className="inner">
          <Link to="/" className="brand" aria-label="Reading home">
            <span aria-hidden>📖</span> Reading
          </Link>
          <nav className="nav" aria-label="Main">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? "active" : "")}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="user-menu">
            {avatar && <img className="avatar" src={avatar} alt="" />}
            <span className="small muted">{name}</span>
            <button className="btn ghost sm" onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </>
  );
}
