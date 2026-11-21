import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EuiAvatar, EuiButton, EuiButtonEmpty, EuiFieldPassword, EuiFieldText, EuiFormRow,
  EuiIcon,
} from "@elastic/eui";
import { Api, errorMessage, type SignIn, type User } from "./api";
import { Failure, Progress } from "./components/Common";
import { PreferenceMenu, Preferences, useLanguage, useT } from "./preferences";
import logo from "./assets/logo.png";
import "./styles.css";

const Accounts = lazy(() => import("./pages/Accounts").then(({ Accounts }) => ({ default: Accounts })));
const Topics = lazy(() => import("./pages/Topics").then(({ Topics }) => ({ default: Topics })));
const Dashboard = lazy(() => import("./pages/Admin").then(({ Dashboard }) => ({ default: Dashboard })));
const DefaultRoute = lazy(() => import("./pages/Admin").then(({ DefaultRoute }) => ({ default: DefaultRoute })));
const Keys = lazy(() => import("./pages/Admin").then(({ Keys }) => ({ default: Keys })));
const Pair = lazy(() => import("./pages/Admin").then(({ Pair }) => ({ default: Pair })));
const Users = lazy(() => import("./pages/Admin").then(({ Users }) => ({ default: Users })));
const Messages = lazy(() => import("./pages/Delivery").then(({ Messages }) => ({ default: Messages })));
const MessageView = lazy(() => import("./pages/Delivery").then(({ MessageView }) => ({ default: MessageView })));
const Send = lazy(() => import("./pages/Delivery").then(({ Send }) => ({ default: Send })));

const sessionKey = "anser.auth.session";
const guest = new Api();
const pages = [
  { path: "/admin", label: "投递总览", icon: "dashboardApp" },
  { path: "/admin/send", label: "发送通知", icon: "play" },
  { path: "/admin/messages", label: "投递记录", icon: "listBullet" },
  { path: "/admin/accounts", label: "渠道账号", icon: "database" },
  { path: "/admin/topics", label: "主题与订阅", icon: "tag" },
  { path: "/admin/routing", label: "默认路由", icon: "branch" },
  { path: "/admin/users", label: "用户", icon: "users" },
  { path: "/admin/api-keys", label: "API Keys", icon: "key" },
  { path: "/admin/pair", label: "配对客户端", icon: "link" },
] as const;

function pathName() {
  return window.location.pathname.replace(/\/$/, "") || "/admin";
}

function readSession() {
  try { return sessionStorage.getItem(sessionKey) ?? undefined; } catch { return undefined; }
}

function writeSession(value?: string) {
  try {
    if (value) sessionStorage.setItem(sessionKey, value);
    else sessionStorage.removeItem(sessionKey);
  } catch {
    // Login remains available when browser storage is disabled.
  }
}

function App() {
  const t = useT();
  const [token, setToken] = useState(readSession);
  const [user, setUser] = useState<User>();
  const [ready, setReady] = useState(false);
  const [path, setPath] = useState(pathName);
  const language = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const update = () => setPath(pathName());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (user) document.getElementById("main")?.focus({ preventScroll: true });
  }, [path, user]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      document.querySelector<HTMLButtonElement>(".nav-trigger")?.focus();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  const navigate = useCallback((to: string, replace = false) => {
    if (pathName() !== to || window.location.pathname !== to) {
      if (replace) history.replaceState(null, "", to);
      else history.pushState(null, "", to);
      setPath(pathName());
    }
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }, []);
  const signOut = useCallback(() => {
    writeSession();
    setToken(undefined); setUser(undefined); setReady(true);
    navigate("/login", true);
  }, [navigate]);
  const api = useMemo(() => new Api(token, signOut), [token, signOut]);

  useEffect(() => {
    if (!token) {
      setReady(true);
      return;
    }
    let active = true;
    const controller = new AbortController();
    void api.read<User>("/auth/me", controller.signal).then((result) => {
      if (!active) return;
      if (!result.admin || !result.enabled) {
        void api.write("/auth/logout", "POST").catch(() => undefined);
        signOut();
        return;
      }
      setUser(result);
      setReady(true);
    }).catch(() => { if (active) signOut(); });
    return () => { active = false; controller.abort(); };
  }, [api, token, signOut]);

  useEffect(() => {
    if (ready && !user && !token && path !== "/login") navigate("/login", true);
    if (ready && user && path === "/login") navigate("/admin", true);
  }, [ready, user, token, path, navigate]);

  function onLogin(result: SignIn) {
    writeSession(result.token);
    setToken(result.token); setUser(result.user); setReady(true);
    navigate("/admin", true);
  }

  let main;
  if (!ready) main = <div className="checking"><Progress label={t("正在检查登录状态")} /></div>;
  else if (!user) main = <Login onLogin={onLogin} />;
  else main = <div className="shell">
    <a className="skip" href="#main">{t("跳至主内容")}</a>
    <header className="shell-header">
      <EuiButtonEmpty className="nav-trigger" size="s" iconType="menu" aria-expanded={menuOpen} aria-controls="main-navigation"
        onClick={() => setMenuOpen((open) => !open)}>{t("菜单")}</EuiButtonEmpty>
      <a href="/admin" className="wordmark" onClick={(event) => { event.preventDefault(); navigate("/admin"); }}>
        <img src={logo} alt="" width="44" height="44" /><strong>{t("雁字")}</strong>{language === "zh-CN" && <span>Anser</span>}
      </a>
      <div className="profile">
        <EuiAvatar size="s" name={user.username} />
        <span>{user.username}</span>
        <PreferenceMenu />
        <EuiButtonEmpty size="s" onClick={() => { void api.write("/auth/logout", "POST").catch(() => undefined).finally(signOut); }}>{t("退出")}</EuiButtonEmpty>
      </div>
    </header>
    <nav className={`sidebar${menuOpen ? " sidebar-open" : ""}`} id="main-navigation" aria-label={t("控制台")}>
      {[pages.slice(0, 3), pages.slice(3, 6), pages.slice(6)].map((group, index) => <ul className="nav-group" key={index}>{group.map((item) => {
        const selected = path === item.path || (item.path !== "/admin" && path.startsWith(`${item.path}/`));
        return <li key={item.path}><a href={item.path} aria-current={selected ? "page" : undefined}
          onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(item.path); }}>
          <EuiIcon type={item.icon} color="inherit" /><span>{t(item.label)}</span>
        </a></li>;
      })}</ul>)}
    </nav>
    <main id="main" className="workspace" tabIndex={-1}><Suspense fallback={<Progress />}><Workspace key={path} path={path} api={api} navigate={navigate} /></Suspense></main>
  </div>;

  return main;
}

function Login({ onLogin }: { onLogin: (result: SignIn) => void }) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  return <main className="login">
    <div className="login-preferences"><PreferenceMenu /></div>
    <div className="login-panel">
      <img className="login-logo" src={logo} alt={t("雁字 Logo")} width="108" height="108" />
      <h1>{t("雁字 Anser")}</h1>
      <p className="login-caption">{t("管理员登录")}</p>
      <form className="stack" onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setFailure(undefined); setBusy(true);
        try {
          const result = await guest.write<SignIn>("/auth/login", "POST", { username: username.trim(), password });
          if (!result.user.admin || !result.user.enabled) {
            void new Api(result.token).write("/auth/logout", "POST").catch(() => undefined);
            setPassword("");
            setFailure("此账号无法访问管理控制台。请使用启用的管理员账号。");
            return;
          }
          setPassword("");
          onLogin(result);
        } catch (error) { setFailure(errorMessage(error)); }
        finally { setBusy(false); }
      }}>
        <Failure message={failure} />
        <EuiFormRow label={t("用户名")} fullWidth><EuiFieldText autoComplete="username" required fullWidth
          value={username} onChange={(event) => setUsername(event.target.value)} /></EuiFormRow>
        <EuiFormRow label={t("密码")} fullWidth><EuiFieldPassword required fullWidth type="password" autoComplete="current-password"
          value={password} onChange={(event) => setPassword(event.target.value)} /></EuiFormRow>
        <EuiButton fill fullWidth type="submit" isLoading={busy}>{t("登录")}</EuiButton>
      </form>
    </div>
  </main>;
}

function decodeSegment(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function Workspace({ path, api, navigate }: { path: string; api: Api; navigate: (path: string) => void }) {
  const detail = /^\/admin\/messages\/([^/]+)$/.exec(path);
  if (detail) return <MessageView api={api} id={decodeSegment(detail[1])} navigate={navigate} />;
  switch (path) {
    case "/admin/send": return <Send api={api} navigate={navigate} />;
    case "/admin/messages": return <Messages api={api} navigate={navigate} />;
    case "/admin/accounts": return <Accounts api={api} />;
    case "/admin/topics": return <Topics api={api} />;
    case "/admin/routing": return <DefaultRoute api={api} />;
    case "/admin/users": return <Users api={api} />;
    case "/admin/api-keys": return <Keys api={api} />;
    case "/admin/pair": return <Pair api={api} />;
    default: return <Dashboard api={api} navigate={navigate} />;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing Anser administrator application root");
createRoot(root).render(<Preferences><App /></Preferences>);
