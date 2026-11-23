import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EuiButton, EuiButtonEmpty, EuiFieldPassword, EuiFieldText, EuiFlyout, EuiFlyoutBody, EuiFlyoutHeader, EuiFormRow, EuiTitle,
} from "@elastic/eui";
import { Api, ApiError, errorMessage, type SignIn, type User } from "./api";
import { SendSession } from "./send-draft";
import { Failure, Progress } from "./components/Common";
import { ProfileMenu } from "./components/ProfileMenu";
import { PreferenceMenu, Preferences, useT } from "./preferences";
import logo from "./assets/logo.png";
import overviewIcon from "./assets/icons/chart-bar.svg?no-inline";
import sendIcon from "./assets/icons/send.svg?no-inline";
import historyIcon from "./assets/icons/history.svg?no-inline";
import accountsIcon from "./assets/icons/id-badge.svg?no-inline";
import channelsIcon from "./assets/icons/plug.svg?no-inline";
import topicsIcon from "./assets/icons/tag.svg?no-inline";
import routingIcon from "./assets/icons/route.svg?no-inline";
import proxyIcon from "./assets/icons/router.svg?no-inline";
import usersIcon from "./assets/icons/user-group.svg?no-inline";
import keysIcon from "./assets/icons/key.svg?no-inline";
import pairIcon from "./assets/icons/scan-qr.svg?no-inline";
import securityIcon from "./assets/icons/shield.svg?no-inline";
import aboutIcon from "./assets/icons/info.svg?no-inline";
import "./styles.css";

const Accounts = lazy(() => import("./pages/Accounts").then(({ Accounts }) => ({ default: Accounts })));
const Channels = lazy(() => import("./pages/Channels").then(({ Channels }) => ({ default: Channels })));
const ChannelSettings = lazy(() => import("./pages/Channels").then(({ ChannelSettings }) => ({ default: ChannelSettings })));
const Topics = lazy(() => import("./pages/Topics").then(({ Topics }) => ({ default: Topics })));
const Dashboard = lazy(() => import("./pages/Admin").then(({ Dashboard }) => ({ default: Dashboard })));
const DefaultRoute = lazy(() => import("./pages/Admin").then(({ DefaultRoute }) => ({ default: DefaultRoute })));
const Keys = lazy(() => import("./pages/Admin").then(({ Keys }) => ({ default: Keys })));
const Pair = lazy(() => import("./pages/Pair"));
const Users = lazy(() => import("./pages/Admin").then(({ Users }) => ({ default: Users })));
const Messages = lazy(() => import("./pages/Delivery").then(({ Messages }) => ({ default: Messages })));
const MessageView = lazy(() => import("./pages/Delivery").then(({ MessageView }) => ({ default: MessageView })));
const Send = lazy(() => import("./pages/Delivery").then(({ Send }) => ({ default: Send })));
const Security = lazy(() => import("./pages/Security").then(({ Security }) => ({ default: Security })));
const Proxies = lazy(() => import("./pages/Proxies").then(({ Proxies }) => ({ default: Proxies })));
const About = lazy(() => import("./pages/About"));

const sessionKey = "anser.auth.session";
const guest = new Api();
const compactNavigation = window.matchMedia("(max-width: 740px)");
const pages = [
  { path: "/admin", label: "投递总览", icon: overviewIcon },
  { path: "/admin/send", label: "发送通知", icon: sendIcon },
  { path: "/admin/messages", label: "投递记录", icon: historyIcon },
  { path: "/admin/accounts", label: "渠道账号", icon: accountsIcon },
  { path: "/admin/channels", label: "渠道插件", icon: channelsIcon },
  { path: "/admin/topics", label: "主题与订阅", icon: topicsIcon },
  { path: "/admin/routing", label: "默认路由", icon: routingIcon },
  { path: "/admin/proxies", label: "出站代理", icon: proxyIcon },
  { path: "/admin/users", label: "用户", icon: usersIcon },
  { path: "/admin/api-keys", label: "API 密钥", icon: keysIcon },
  { path: "/admin/pair", label: "配对客户端", icon: pairIcon },
  { path: "/admin/security", label: "账号安全", icon: securityIcon },
  { path: "/admin/about", label: "关于", icon: aboutIcon },
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
  const initialPath = useRef(path);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(() => compactNavigation.matches);

  useEffect(() => {
    const update = () => { setPath(pathName()); setMenuOpen(false); };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (user) document.getElementById("main")?.focus({ preventScroll: true });
  }, [path, user]);

  useEffect(() => {
    const resize = ({ matches }: MediaQueryListEvent) => {
      setCompact(matches);
      if (!matches) setMenuOpen(false);
    };
    compactNavigation.addEventListener("change", resize);
    return () => compactNavigation.removeEventListener("change", resize);
  }, []);

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
  const sendSession = useMemo(() => new SendSession(), [token]);

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
    const target = initialPath.current;
    initialPath.current = "/admin";
    navigate(target.startsWith("/admin/") ? target : "/admin", true);
  }

  let main;
  if (!ready) main = <div className="checking"><Progress label={t("正在检查登录状态")} /></div>;
  else if (!user) main = <Login onLogin={onLogin} />;
  else main = <div className="shell">
    <a className="skip" href="#main">{t("跳至主内容")}</a>
    <header className="shell-header">
      <EuiButtonEmpty className="nav-trigger" size="s" iconType="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? "compact-navigation" : undefined}
        aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>{t("菜单")}</EuiButtonEmpty>
      <a href="/admin" className="wordmark" onClick={(event) => { event.preventDefault(); navigate("/admin"); }}>
        <img src={logo} alt="" width="44" height="44" /><strong>{t("雁字")}</strong>
      </a>
      <div className="profile">
        <PreferenceMenu />
        <ProfileMenu key={user.id} api={api} username={user.username} security={() => navigate("/admin/security")} signOut={() => {
          initialPath.current = "/admin";
          void api.write("/auth/logout", "POST").catch(() => undefined).finally(signOut);
        }} />
      </div>
    </header>
    {compact ? menuOpen && <EuiFlyout id="compact-navigation" className="console-navigation-flyout"
      side="left" size="min(85vw, 320px)" paddingSize="m" ownFocus outsideClickCloses
      focusTrapProps={{ returnFocus: false }} onClose={() => {
        setMenuOpen(false);
        requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".nav-trigger")?.focus());
      }} aria-labelledby="compact-navigation-title">
      <EuiFlyoutHeader hasBorder><EuiTitle size="s"><h2 id="compact-navigation-title">{t("控制台")}</h2></EuiTitle></EuiFlyoutHeader>
      <EuiFlyoutBody><Navigation path={path} navigate={(to) => {
        navigate(to);
        requestAnimationFrame(() => document.getElementById("main")?.focus({ preventScroll: true }));
      }} /></EuiFlyoutBody>
    </EuiFlyout> : <Navigation path={path} navigate={navigate} sidebar />}
    <main id="main" className="workspace" tabIndex={-1}><Suspense fallback={<Progress />}><Workspace key={path} path={path} api={api} username={user.username} sendSession={sendSession} navigate={navigate} /></Suspense></main>
  </div>;

  return main;
}

function Navigation({ path, navigate, sidebar }: { path: string; navigate: (path: string) => void; sidebar?: boolean }) {
  const t = useT();
  return <nav className={sidebar ? "sidebar" : undefined} aria-label={t("控制台")}>
      {[pages.slice(0, 3), pages.slice(3, 8), pages.slice(8)].map((group, index) => <ul className="nav-group" key={index}>{group.map((item) => {
        const selected = path === item.path || (item.path !== "/admin" && path.startsWith(`${item.path}/`));
        return <li key={item.path}><a href={item.path} aria-current={selected ? "page" : undefined}
          onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(item.path); }}>
          <img className="nav-icon" src={item.icon} alt="" aria-hidden="true" width="24" height="24" /><span>{t(item.label)}</span>
        </a></li>;
      })}</ul>)}
  </nav>;
}

function Login({ onLogin }: { onLogin: (result: SignIn) => void }) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  function resetChallenge() {
    setChallenge(false);
    setPassword("");
    setCode("");
  }
  return <main className="login">
    <div className="login-preferences"><PreferenceMenu /></div>
    <div className="login-panel">
      <img className="login-logo" src={logo} alt={t("雁字标志")} width="108" height="108" />
      <h1>{t("雁字")}</h1>
      <p className="login-caption">{t(challenge ? "双重验证" : "管理员登录")}</p>
      <form className="stack" onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setFailure(undefined); setBusy(true);
        try {
          const result = await guest.write<SignIn>("/auth/login", "POST", {
            username: username.trim(), password, code: challenge ? code.trim() : undefined,
          });
          resetChallenge();
          if (!result.user.admin || !result.user.enabled) {
            void new Api(result.token).write("/auth/logout", "POST").catch(() => undefined);
            setFailure("此账号无法访问管理控制台。请使用启用的管理员账号。");
            return;
          }
          onLogin(result);
        } catch (error) {
          if (error instanceof ApiError && error.code === "totp_required") {
            setChallenge(true);
            setCode("");
            return;
          }
          if (challenge && error instanceof ApiError && error.status === 401) {
            if (error.code === "invalid_totp") setCode("");
            else resetChallenge();
          }
          setFailure(errorMessage(error));
        }
        finally { setBusy(false); }
      }}>
        <Failure message={failure} />
        {challenge
          ? <EuiFormRow label={t("验证码或恢复代码")} helpText={t("使用验证器应用中的验证码，或输入一条恢复代码。")} fullWidth>
            <EuiFieldText autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} autoFocus
              readOnly={busy} required fullWidth value={code} onChange={(event) => setCode(event.target.value)} />
          </EuiFormRow>
          : <>
            <EuiFormRow label={t("用户名")} fullWidth><EuiFieldText autoComplete="username" readOnly={busy} required fullWidth
              value={username} onChange={(event) => setUsername(event.target.value)} /></EuiFormRow>
            <EuiFormRow label={t("密码")} fullWidth><EuiFieldPassword required fullWidth type="dual" autoComplete="current-password"
              readOnly={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></EuiFormRow>
          </>}
        <EuiButton fill fullWidth type="submit" isLoading={busy}>{t(challenge ? "验证并登录" : "登录")}</EuiButton>
        {challenge && <EuiButtonEmpty disabled={busy} onClick={() => { resetChallenge(); setFailure(undefined); }}>{t("返回登录")}</EuiButtonEmpty>}
      </form>
    </div>
  </main>;
}

function decodeSegment(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function Workspace({ path, api, username, sendSession, navigate }: { path: string; api: Api; username: string; sendSession: SendSession; navigate: (path: string) => void }) {
  const detail = /^\/admin\/messages\/([^/]+)$/.exec(path);
  if (detail) return <MessageView api={api} id={decodeSegment(detail[1])} navigate={navigate} />;
  const channel = /^\/admin\/channels\/([^/]+)$/.exec(path);
  if (channel) return <ChannelSettings api={api} id={decodeSegment(channel[1])} navigate={navigate} />;
  switch (path) {
    case "/admin/send": return <Send api={api} session={sendSession} navigate={navigate} />;
    case "/admin/messages": return <Messages api={api} navigate={navigate} />;
    case "/admin/accounts": return <Accounts api={api} />;
    case "/admin/channels": return <Channels api={api} navigate={navigate} />;
    case "/admin/topics": return <Topics api={api} />;
    case "/admin/routing": return <DefaultRoute api={api} />;
    case "/admin/proxies": return <Proxies api={api} />;
    case "/admin/users": return <Users api={api} />;
    case "/admin/api-keys": return <Keys api={api} />;
    case "/admin/pair": return <Pair api={api} username={username} />;
    case "/admin/security": return <Security api={api} />;
    case "/admin/about": return <About api={api} />;
    default: return <Dashboard api={api} navigate={navigate} />;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing Anser administrator application root");
createRoot(root).render(<Preferences><App /></Preferences>);
