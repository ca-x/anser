import { t } from "nsh/i18n";
import { DesktopTray } from "anser-native";
import {
  cleanup,
  effect,
  Image,
  LayoutAnimation,
  platform,
  reduceMotion,
  resource,
  Scroll,
  signal,
  Text,
  UrlScheme,
  View,
  windowSize,
  type ImageAsset,
  type Signal,
} from "nsh";
import { Button, createNavStack, NavStack, Tooltip } from "nsh/base";
import { Application, currentWindow, isAvailable as desktopAvailable, Tray } from "nsh/desktop";
import { TabBar } from "nsh/mobile";
import { Head } from "nsh/web";
import { messageFor, type AnserApi } from "./api";
import appIcon from "./assets/logo.png";
import accountIcon from "./assets/navigation/id-badge.svg";
import historyIcon from "./assets/navigation/history.svg";
import inboxIcon from "./assets/navigation/inbox.svg";
import preferencesIcon from "./assets/navigation/settings.svg";
import sendIcon from "./assets/navigation/send.svg";
import tagIcon from "./assets/navigation/tag.svg";
import { SpeechPlayer, speechPlayback, type SpeechPlayback } from "./components/Speech";
import { Action, Hint, Panel } from "./components/Controls";
import { AccountMenu } from "./components/AccountMenu";
import { Brand, WorkspacePage } from "./components/Workspace";
import { NotificationControls, PreferenceControls } from "./components/Preferences";
import { ServerProfiles } from "./components/ServerProfiles";
import { createPreferences, type Preferences } from "./preferences";
import type { Account, Channel, ProxyProfile, Topic, User } from "./contracts";
import { decodeInboxNoticeId, inboxState, systemNotifications, type InboxState, type SystemNotifications } from "./inbox";
import type { Pairing } from "./pairing";
import { parsePairing } from "./pairing";
import { AccountEditor, Accounts } from "./pages/Accounts";
import { About } from "./pages/About";
import { Compose, composeDraft } from "./pages/Compose";
import { Connection } from "./pages/Connection";
import { DefaultRoute } from "./pages/DefaultRoute";
import { History, MessageDetail } from "./pages/History";
import { Inbox, inboxDraft, InboxDetail, InboxSend } from "./pages/Inbox";
import { PluginSettings, Plugins } from "./pages/Plugins";
import { Profile } from "./pages/Profile";
import { ProxyEditor, ProxyProfiles } from "./pages/Proxies";
import { Security } from "./pages/Security";
import { TopicDetail, TopicEditor, Topics } from "./pages/Topics";
import { createServers, type Servers } from "./servers";

type Session = {
  id: number;
  inbox: Signal<InboxState | undefined>;
  api: AnserApi;
  channels: Signal<Channel[]>;
  catalogUnavailable: Signal<boolean>;
  expired: Signal<boolean>;
  authMethod?: AuthMethod;
  user?: User;
  compose: ReturnType<typeof sessionDrafts<ReturnType<typeof composeDraft>>>;
  inboxDraft: ReturnType<typeof sessionDrafts<ReturnType<typeof inboxDraft>>>;
};

type AuthMethod = "password" | "key" | "pairing";
type Section = "compose" | "topics" | "accounts" | "history" | "inbox" | "more";

type Route =
  | { name: "compose"; topic?: Topic }
  | { name: "topics" }
  | { name: "topic"; topic: Topic }
  | { name: "topic-editor"; topic?: Topic }
  | { name: "default-route" }
  | { name: "preferences" }
  | { name: "notifications" }
  | { name: "more" }
  | { name: "servers" }
  | { name: "connect-server"; origin: string; activate: boolean; invitation?: Pairing }
  | { name: "about" }
  | { name: "security" }
  | { name: "accounts" }
  | { name: "account-editor"; account?: Account; presetChannel?: string }
  | { name: "plugins" }
  | { name: "proxies" }
  | { name: "proxy-editor"; profile?: ProxyProfile }
  | { name: "plugin"; channel: Channel }
  | { name: "history" }
  | { name: "message"; id: string }
  | { name: "remote-message"; id: string; origin: string }
  | { name: "inbox" }
  | { name: "inbox-detail"; id: number }
  | { name: "inbox-send"; recipient?: string };

const sections: {
  id: Section;
  title: () => string;
  icon: ImageAsset;
  ios: string;
  android: string;
}[] = [
  {
    id: "compose",
    title: () => t("shell.send"),
    icon: sendIcon,
    ios: "paperplane",
    android: "android:ic_menu_send",
  },
  {
    id: "topics",
    title: () => t("shell.topics"),
    icon: tagIcon,
    ios: "tag",
    android: "android:ic_menu_agenda",
  },
  {
    id: "accounts",
    title: () => t("accounts.channel_accounts"),
    icon: accountIcon,
    ios: "person.crop.circle",
    android: "android:ic_menu_manage",
  },
  {
    id: "history",
    title: () => t("shell.deliveries"),
    icon: historyIcon,
    ios: "clock",
    android: "android:ic_menu_recent_history",
  },
  {
    id: "inbox",
    title: () => t("common.inbox"),
    icon: inboxIcon,
    ios: "tray",
    android: "android:ic_dialog_email",
  },
  {
    id: "more",
    title: () => t("shell.more"),
    icon: preferencesIcon,
    ios: "ellipsis.circle",
    android: "android:ic_menu_more",
  },
];

export function AnserApp() {
  const preferences = createPreferences();
  const servers = createServers();
  let restoreWindow = () => {};
  if (desktopAvailable && platform.os !== "web") {
    const appWindow = currentWindow();
    const restore = () => {
      appWindow.show();
      appWindow.focus();
    };
    restoreWindow = restore;
    const flush = () => Promise.all([servers.flush(), preferences.flush()]).then(() => {});
    let quitting = false;
    const quit = () => {
      if (quitting) return;
      quitting = true;
      void flush().finally(() => Application.quit());
    };
    appWindow.set({ closeOnPress: false });
    let checkingTray = false;
    appWindow.on("closePress", () => {
      if (preferences.settings().closeBehavior !== "tray") {
        quit();
        return;
      }
      if (platform.os !== "linux") {
        appWindow.hide();
        return;
      }
      if (checkingTray) return;
      checkingTray = true;
      void DesktopTray.hostAvailable().then((available) => {
        if (quitting || preferences.settings().closeBehavior !== "tray") return;
        if (available) appWindow.hide();
        else appWindow.minimize();
      }, () => appWindow.minimize()).finally(() => { checkingTray = false; });
    });
    // Some packaged NSH hosts only expose secondInstance. The tray can
    // restore the window on every host, including those without reopen.
    try {
      cleanup(Application.on("reopen", restore));
    } catch {
      if (platform.os === "linux" || platform.os === "windows")
        cleanup(Application.on("secondInstance", restore));
    }
    cleanup(Application.on("quit", flush));
    cleanup(Application.on("quitRequest", quit));
    effect(() => {
      const title = t("workspace.anser");
      appWindow.set({ title });
      Tray.set(preferences.settings().closeBehavior === "tray" ? {
        icon: appIcon,
        tooltip: title,
        onClick: restore,
        menu: [
          { label: t("preferences.show_window"), onSelect: restore },
          { label: t("preferences.quit"), onSelect: quit },
        ],
      } : null);
    });
    cleanup(() => Tray.set(null));
  }
  const session = signal<Session | undefined>(undefined);
  const sessions = signal<Session[]>([]);
  let sessionId = 0;
  const speech = speechPlayback(preferences);
  const inboxRoute = signal<{ server: number; id?: number }>();
  function switchServer(origin: string) {
    const next = sessions().find((item) => item.api.origin === origin);
    if (!next) return;
    servers.remember(origin, true);
    session.set(next);
  }
  const notifications = systemNotifications(preferences, (notice) => {
    const target = decodeInboxNoticeId(notice);
    if (!target) return;
    const connection = sessions().find((item) => item.id === target.sessionId && !item.expired());
    if (!connection || (target.id !== undefined && !connection.inbox()?.items().some((item) => item.id === target.id))) return;
    switchServer(connection.api.origin);
    inboxRoute.set({ server: connection.id, id: target.id });
    restoreWindow();
  }, () => sessions().reduce((sum, connection) => sum + (connection.inbox()?.unread() ?? 0), 0));
  const pairing = signal<Pairing | undefined>(undefined);
  const linkError = signal("");
  const disconnecting = signal(false);
  const listener = UrlScheme.on("open", ({ url }) => {
    try {
      pairing.set(parsePairing(url));
      linkError.set("");
    } catch (error) {
      linkError.set(messageFor(error));
    }
  });
  cleanup(() => {
    listener();
    for (const connection of sessions()) connection.api.close();
  });

  function handlePairing(invite: Pairing) {
    if (pairing() === invite) pairing.set(undefined);
  }

  function connected(
    api: AnserApi,
    channels: Channel[],
    user?: User,
    activate = true,
    catalogUnavailable = false,
    authMethod?: AuthMethod,
  ) {
    linkError.set("");
    const previous = sessions().find((item) => item.api.origin === api.origin);
    const reauth = previous && previous.expired() && previous.user && previous.user.id === user?.id ? previous : undefined;
    if (previous) {
      speech.forget(previous.api.origin);
      if (previous.authMethod && previous.authMethod !== "key" && !previous.expired()) {
        void previous.api.logout().catch(() => undefined).finally(() => previous.api.close());
      } else previous.api.close();
    }
    const expired = signal(false);
    api.onUnauthorized = () => expired.set(true);
    const connection = {
      id: ++sessionId,
      inbox: signal<InboxState | undefined>(),
      api,
      channels: signal(channels),
      catalogUnavailable: signal(catalogUnavailable),
      expired,
      authMethod,
      user,
      compose: reauth?.compose ?? sessionDrafts(composeDraft),
      inboxDraft: reauth?.inboxDraft ?? sessionDrafts(inboxDraft),
    };
    sessions.update((items) => [...items.filter((item) => item !== previous), connection]);
    servers.remember(api.origin, activate);
    if (activate || session() === previous) session.set(connection);
  }

  async function signOut() {
    const current = session();
    if (!current || disconnecting()) return;
    disconnecting.set(true);
    // Remove local session, screens, and notification previews immediately.
    const remaining = sessions().filter((item) => item !== current);
    sessions.set(remaining);
    speech.forget(current.api.origin);
    const next = remaining.find((item) => !item.expired()) ?? remaining[0];
    session.set(next);
    if (next) servers.remember(next.api.origin, true);
    if (current.authMethod !== "key" && current.user)
      void current.api
        .logout()
        .catch(() => undefined)
        .finally(() => current.api.close());
    else current.api.close();
    disconnecting.set(false);
  }

  return (
    <View class="flex-1 bg-background" testID="app-background">
      {platform.os === "web" && <Head title={t("workspace.anser")} />}
      <Each of={sessions()} key={(connection) => connection.id}>
        {(connection) => <If when={!connection().expired()}>
          <InboxConnection session={connection()} speech={speech} notifications={notifications} />
        </If>}
      </Each>
      <SpeechPlayer state={speech} />
      <If when={preferences.ready() && servers.ready()}>
        <If
          when={session()}
          else={
            <Connection
              preferences={preferences}
              servers={servers}
              pairing={pairing()}
              linkError={linkError()}
              onPairingHandled={handlePairing}
              onConnect={(api, channels, user, missingCatalog, method) => connected(api, channels, user, true, missingCatalog, method)}
            />
          }
        >
          {(active) => (
            <Each of={[active()]} key={(current) => current.id}>
              {(current) => (
                <Workspace
                  preferences={preferences}
                  servers={servers}
                  session={current()}
                  sessions={sessions()}
                  onSwitch={switchServer}
                  speech={speech}
                  notifications={notifications}
                  inboxRoute={inboxRoute}
                  onConnect={connected}
                  onDisconnect={signOut}
                  pendingPairing={pairing()}
                  onDismissPairing={handlePairing}
                />
              )}
            </Each>
          )}
        </If>
      </If>
    </View>
  );
}

function InboxConnection(props: {
  session: Session;
  speech: SpeechPlayback;
  notifications: SystemNotifications;
}) {
  const { session, speech, notifications } = props;
  if (!session.user) return null;
  const { origin } = session.api;
  const inbox = inboxState(session.api, (items) => {
    const queued = speech.received(origin, items);
    notifications.received(session.id, items, queued);
  }, notifications, session.id);
  session.inbox.set(inbox);
  cleanup(() => session.inbox.set(undefined));
  return null;
}

// Scope unsent work and pending request keys to the current server session.
function sessionDrafts<T>(create: (destination: string) => T) {
  const drafts = new Map<string, T>();
  return (destination = "") => {
    const existing = drafts.get(destination);
    if (existing !== undefined) return existing;
    const draft = create(destination);
    drafts.set(destination, draft);
    return draft;
  };
}

function Workspace(props: {
  session: Session;
  sessions: Session[];
  preferences: Preferences;
  servers: Servers;
  onSwitch: (origin: string) => void;
  speech: SpeechPlayback;
  notifications: SystemNotifications;
  inboxRoute: Signal<{ server: number; id?: number } | undefined>;
  onConnect: (api: AnserApi, channels: Channel[], user?: User, activate?: boolean,
    catalogUnavailable?: boolean, authMethod?: AuthMethod) => void;
  onDisconnect: () => void;
  pendingPairing?: Pairing;
  onDismissPairing: (invite: Pairing) => void;
}) {
  const { api, user } = props.session;
  const profile = resource(Boolean(user), (_, { signal }) =>
    api.profile(signal),
  );
  const showProfile = signal(false);
  const displayName = () => profile()?.nickname || user?.username || "";
  const serverName = () => props.servers.label(api.origin);
  const isConnected = (origin: string) => props.sessions.some((item) => item.api.origin === origin && !item.expired());
  const channels = props.session.channels;
  const outboundChannels = () => channels().filter((channel) => channel.direction !== "ingress");
  const accountsRevision = signal(0);
  const proxyRevision = signal(0);
  const nav = createNavStack<Route>([{ name: "compose" }]);
  const draftFor = props.session.compose;
  const inboxDraftFor = props.session.inboxDraft;
  const selection = signal<Section>("compose");
  const systemTabs = platform.os === "ios" || platform.os === "android";
  const wide = () => !systemTabs && windowSize().width >= 780;
  const collapsed = () => wide() && props.preferences.settings().sidebarCollapsed === true;

  const globalAdmin = () => {
    const permissions = channels().filter(
      (channel) => channel.can_manage !== undefined,
    );
    return permissions.length
      ? permissions.some((channel) => channel.can_manage)
      : user?.admin === true;
  };
  const accountAdmin = globalAdmin;
  const open = (page: Route) => nav.push(page);
  const back = () => nav.pop();
  const openPreferences = () => {
    const current = nav.routes().at(-1)?.name;
    if (current === "about") back();
    else if (current !== "preferences") open({ name: "preferences" });
  };
  const finishAccountEdit = () => {
    accountsRevision.update((revision) => revision + 1);
    back();
  };
  const openServers = () => {
    if (nav.routes().at(-1)?.name !== "servers") open({ name: "servers" });
  };
  const showingServers = () => nav.routes().at(-1)?.name === "servers";
  function selectServer(origin: string) {
    if (origin === api.origin && !props.session.expired()) return;
    if (isConnected(origin)) props.onSwitch(origin);
    else open({ name: "connect-server", origin, activate: true });
  }
  const go = (tab: Section) => {
    if (selection() !== tab || nav.routes().length !== 1) {
      selection.set(tab);
      nav.setRoutes([{ name: tab }]);
    }
  };
  const speech = props.speech;
  const inbox = () => props.session.inbox();
  effect(() => {
    const target = props.inboxRoute();
    if (target?.server !== props.session.id || !inbox()) return;
    selection.set("inbox");
    nav.setRoutes(target.id === undefined
      ? [{ name: "inbox" }]
      : [{ name: "inbox" }, { name: "inbox-detail", id: target.id }]);
    props.inboxRoute.set(undefined);
  });
  const activeSection = () => !wide() && selection() === "accounts" ? "more" : selection();
  const enabledSections = () => sections.filter((tab) =>
    (tab.id !== "inbox" || Boolean(user)) &&
    (tab.id !== "accounts" || (accountAdmin() && wide())) &&
    (tab.id !== "more" || !wide()),
  );

  const loadingCatalog = signal(false);
  async function retryCatalog() {
    if (loadingCatalog() || props.session.expired()) return;
    loadingCatalog.set(true);
    try {
      channels.set(await api.channels());
      props.session.catalogUnavailable.set(false);
    } catch {
      props.session.catalogUnavailable.set(true);
    } finally {
      loadingCatalog.set(false);
    }
  }

  let attemptedCatalog = false;
  effect(() => {
    if (props.session.catalogUnavailable() && !attemptedCatalog) {
      attemptedCatalog = true;
      void retryCatalog();
    }
  });

  const badge = (tab: Section) => {
    const count = tab === "inbox" ? (inbox()?.unread() ?? 0) : 0;
    return count ? (count > 99 ? "99+" : String(count)) : undefined;
  };

  const links = () => (
    <Each of={enabledSections()} key={(tab) => tab.id}>
      {(tab) => {
        const selected = () => !showingServers() && activeSection() === tab().id;
        return (
          <Button
            onPress={() => go(tab().id)}
            accessibilityLabel={collapsed() ? (badge(tab().id) ? `${tab().title()} (${badge(tab().id)})` : tab().title()) : undefined}
            selected={selected()}
            tooltip={collapsed() ? navigationTip(tab().title()) : undefined}
            class={`min-h-11 rounded-(--radius) items-center hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring transition-colors duration-100 motion-reduce:transition-none ${collapsed() ? "justify-center" : wide() ? "flex-row gap-2.5 px-3 py-2" : "min-w-0 flex-1 justify-center gap-0.5 px-1 py-1"} ${selected() ? "bg-accent" : ""}`}
          >
            <Image
              src={tab().icon}
              class="size-6 shrink-0"
              fadeDuration={0}
              accessibilityElementsHidden
            />
            <If when={!collapsed()}><Text
              class={`${wide() ? "text-sm" : "text-center text-xs"} ${selected() ? "font-semibold text-accent-foreground" : "text-foreground"}`}
            >
              {tab().title()}
              {badge(tab().id) ? ` (${badge(tab().id)})` : ""}
            </Text>
            </If>
          </Button>
        );
      }}
    </Each>
  );

  return (
    <View class="flex-1">
      <If when={props.pendingPairing}>
        {(invite) => (
          <View class="flex-row flex-wrap items-center gap-2 border-b border-border bg-card px-4 pt-[env(safe-area-inset-top)]">
            <Text class="flex-1 text-sm text-foreground">
              {t("shell.invitation_from_server", { origin: invite().origin })}
            </Text>
            <Action
              label={t("shell.review_invitation")}
              onPress={() => {
                const invitation = invite();
                open({ name: "connect-server", origin: invitation.origin, activate: true, invitation });
                props.onDismissPairing(invitation);
              }}
            />
            <Action
              label={t("shell.ignore")}
              kind="quiet"
              onPress={() => props.onDismissPairing(invite())}
            />
          </View>
        )}
      </If>
      <If when={props.session.expired() || props.session.catalogUnavailable()}>
        <View class="flex-row flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-1">
          <Hint>{t(props.session.expired() ? "shell.session_expired" : "shell.catalog_unavailable")}</Hint>
          <Action label={t(props.session.expired() ? "servers.sign_in" : "common.refresh")} kind="quiet"
            disabled={loadingCatalog()} onPress={() => props.session.expired() ? selectServer(api.origin) : void retryCatalog()} />
        </View>
      </If>
      <View class={wide() ? "flex-1 flex-row" : "flex-1"}>
        <If when={wide()}>
          <View
            role="navigation"
            testID="desktop-sidebar"
            class={`shrink-0 gap-3 border-r border-border bg-sidebar pt-4 pb-3 ${collapsed() ? "w-16 px-2" : "w-52 px-3"}`}
          >
            <View class={`min-w-0 items-center ${collapsed() ? "gap-2" : "flex-row justify-between gap-2 pl-1"}`}>
              <Brand compact iconOnly={collapsed()} />
              <Button
                accessibilityLabel={t(collapsed() ? "shell.expand_sidebar" : "shell.collapse_sidebar")}
                tooltip={navigationTip(t(collapsed() ? "shell.expand_sidebar" : "shell.collapse_sidebar"))}
                class="min-h-11 min-w-11 items-center justify-center rounded-(--radius) hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onPress={() => {
                  if (!reduceMotion()) LayoutAnimation.configureNext(
                    LayoutAnimation.create(180, "easeInEaseOut", "opacity"),
                  );
                  props.preferences.toggleSidebar();
                }}
              >
                <Text accessibilityElementsHidden class="text-lg text-foreground">{collapsed() ? "›" : "‹"}</Text>
              </Button>
            </View>
            <Scroll class="min-h-0 flex-1">
            <View class="gap-0.5">
              {links()}
              <Button
                accessibilityLabel={t("servers.title")}
                selected={showingServers()}
                tooltip={collapsed() ? navigationTip(t("servers.title")) : undefined}
                class={`min-h-11 items-center rounded-(--radius) hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring transition-colors duration-100 motion-reduce:transition-none ${collapsed() ? "justify-center" : "flex-row gap-2.5 px-3 py-2"} ${showingServers() ? "bg-accent" : ""}`}
                onPress={openServers}
              >
                <Image src={accountIcon} class="size-6 shrink-0" fadeDuration={0} accessibilityElementsHidden />
                <If when={!collapsed()}>
                  <Text class={showingServers() ? "text-sm font-semibold text-accent-foreground" : "text-sm text-foreground"}>{t("servers.title")}</Text>
                </If>
              </Button>
            </View>
            </Scroll>
            <View class="shrink-0 gap-0.5 border-t border-border pt-2">
              <If
                when={user}
                else={
                  <If when={!collapsed()}><View class="gap-1 px-3 pb-2">
                    <Hint>{t("shell.api_key_session")}</Hint>
                    <Text
                      class="line-clamp-1 text-sm text-muted-foreground"
                    >
                      {serverName()}
                    </Text>
                  </View></If>
                }
              >
                <AccountMenu
                  name={displayName()}
                  avatar={profile()?.avatar}
                  server={serverName()}
                  iconOnly={collapsed()}
                  onProfile={() => showProfile.set(true)}
                  onSecurity={() => open({ name: "security" })}
                />
              </If>
              <Action
                label={t("preferences.title")}
                icon={preferencesIcon}
                iconOnly={collapsed()}
                tooltip={collapsed() ? navigationTip(t("preferences.title")) : undefined}
                onPress={openPreferences}
                kind="quiet"
                class="self-start"
              />
              <Action
                label={collapsed() ? "↪" : t("shell.disconnect")}
                accessibilityLabel={t("shell.disconnect")}
                tooltip={collapsed() ? navigationTip(t("shell.disconnect")) : undefined}
                onPress={() => props.onDisconnect()}
                kind="quiet"
                class="self-start"
              />
            </View>
          </View>
        </If>
        <NavStack state={nav} class="min-w-0 flex-1">
          {(route) => {
            switch (route.name) {
              case "compose":
                return (
                  <Compose
                    api={api}
                    channels={outboundChannels()}
                    canManageTargets={globalAdmin()}
                    onManageChannels={() => wide() ? go("accounts") : open({ name: "accounts" })}
                    draft={draftFor(route.topic?.name)}
                    servers={props.servers}
                    connections={props.sessions.filter((item) => !item.expired()).map((item) => item.api)}
                    onConnectServer={(origin) => open({ name: "connect-server", origin, activate: false })}
                    onManageServers={openServers}
                    onServerDelivery={(origin, id) => {
                      if (origin === api.origin) open({ name: "message", id });
                      else open({ name: "remote-message", origin, id });
                    }}
                    fixedTopic={route.topic}
                    onBack={route.topic ? back : undefined}
                    onAccepted={(id) => {
                      const top = nav.routes().at(-1);
                      if (
                        top?.name === "compose" &&
                        top.topic?.name === route.topic?.name
                      )
                        open({ name: "message", id });
                    }}
                  />
                );
              case "accounts":
                return (
                  <Accounts
                    api={api}
                    channels={outboundChannels()}
                    revision={accountsRevision()}
                    onPlugins={
                      globalAdmin()
                        ? () => open({ name: "plugins" })
                        : undefined
                    }
                    onProxies={
                      globalAdmin()
                        ? () => open({ name: "proxies" })
                        : undefined
                    }
                    onOpen={(account) =>
                      open({ name: "account-editor", account })
                    }
                    onCreate={() => open({ name: "account-editor" })}
                  />
                );
              case "account-editor":
                return (
                  <AccountEditor
                    api={api}
                    channels={outboundChannels()}
                    account={route.account}
                    presetChannel={route.presetChannel}
                    canManageProxies={globalAdmin()}
                    onBack={back}
                    onSaved={finishAccountEdit}
                    onDeleted={finishAccountEdit}
                  />
                );
              case "plugins":
                return (
                  <Plugins
                    api={api}
                    channels={channels()}
                    onBack={back}
                    onOpen={(channel) => open({ name: "plugin", channel })}
                    onRefresh={channels.set}
                  />
                );
              case "proxies":
                return (
                  globalAdmin() && (
                    <ProxyProfiles
                      api={api}
                      revision={proxyRevision()}
                      onBack={back}
                      onOpen={(profile) =>
                        open({ name: "proxy-editor", profile })
                      }
                      onCreate={() => open({ name: "proxy-editor" })}
                    />
                  )
                );
              case "proxy-editor":
                return (
                  globalAdmin() && (
                    <ProxyEditor
                      api={api}
                      profile={route.profile}
                      onBack={back}
                      onSaved={() => {
                        proxyRevision.update((revision) => revision + 1);
                        back();
                      }}
                    />
                  )
                );
              case "plugin":
                return (
                  <PluginSettings
                    api={api}
                    channel={
                      channels().find(
                        (channel) => channel.id === route.channel.id,
                      ) ?? route.channel
                    }
                    admin={globalAdmin()}
                    revision={accountsRevision()}
                    onBack={back}
                    onOpenAccount={(account) =>
                      open({ name: "account-editor", account })
                    }
                    onCreateAccount={() =>
                      open({
                        name: "account-editor",
                        presetChannel: route.channel.id,
                      })
                    }
                    onChange={(updated) =>
                      channels.update((items) =>
                        items.map((channel) =>
                          channel.id === updated.id ? updated : channel,
                        ),
                      )
                    }
                  />
                );
              case "topics":
                return (
                  <Topics
                    api={api}
                    admin={accountAdmin()}
                    onOpen={(topic) => open({ name: "topic", topic })}
                    onCreate={() => open({ name: "topic-editor" })}
                    onDefault={() => open({ name: "default-route" })}
                  />
                );
              case "topic":
                return (
                  <TopicDetail
                    api={api}
                    topic={route.topic}
                    username={user?.username}
                    admin={accountAdmin()}
                    onBack={back}
                    onEdit={() =>
                      open({ name: "topic-editor", topic: route.topic })
                    }
                    onPublish={() =>
                      open({ name: "compose", topic: route.topic })
                    }
                  />
                );
              case "topic-editor":
                return (
                  <TopicEditor
                    api={api}
                    channels={outboundChannels()}
                    topic={route.topic}
                    onBack={back}
                    onSaved={(topic) =>
                      nav.setRoutes([
                        { name: "topics" },
                        { name: "topic", topic },
                      ])
                    }
                    onDeleted={() => nav.setRoutes([{ name: "topics" }])}
                  />
                );
              case "preferences":
                return (
                  <WorkspacePage title={t("preferences.title")} back={back}>
                    <PreferenceControls preferences={props.preferences} />
                    <Action label={t("inbox.notification_settings")} class="self-start" onPress={() => open({ name: "notifications" })} />
                    <Action label={t("servers.title")} class="self-start" onPress={openServers} />
                    <Action
                      label={t("about.title")}
                      class="self-start"
                      onPress={() => open({ name: "about" })}
                    />
                  </WorkspacePage>
                );
              case "notifications":
                return <WorkspacePage title={t("inbox.notification_settings")} back={back}>
                  <NotificationControls notifications={props.notifications} speech={speech} />
                </WorkspacePage>;
              case "more":
                return <WorkspacePage title={t("shell.more")}>
                  <Panel>
                    <If when={user}>
                      <AccountMenu name={displayName()} avatar={profile()?.avatar} server={serverName()}
                        onProfile={() => showProfile.set(true)} onSecurity={() => open({ name: "security" })} />
                    </If>
                    <Action label={t("servers.title")} onPress={openServers} />
                    <If when={accountAdmin()}>
                      <Action label={t("accounts.channel_accounts")} onPress={() => open({ name: "accounts" })} />
                    </If>
                    <Action label={t("preferences.title")} onPress={openPreferences} />
                    <Action label={t("shell.disconnect_2")} kind="quiet" onPress={props.onDisconnect} />
                  </Panel>
                </WorkspacePage>;
              case "servers":
                return (
                  <WorkspacePage title={t("servers.title")} back={back}>
                    <ServerProfiles servers={props.servers} active={props.session.expired() ? undefined : api.origin} isConnected={isConnected} onChoose={selectServer} onConnect={selectServer} />
                  </WorkspacePage>
                );
              case "connect-server":
                return (
                  <WorkspacePage title={t("servers.sign_in")} back={back}>
                    <Connection
                      preferences={props.preferences}
                      servers={props.servers}
                      initialOrigin={route.origin}
                      pairing={route.invitation}
                      replacing={Boolean(route.invitation && isConnected(route.origin))}
                      onPairingHandled={props.onDismissPairing}
                      embedded
                      onConnect={(next, nextChannels, nextUser, missingCatalog, method) => {
                        props.onConnect(next, nextChannels, nextUser, route.activate, missingCatalog, method);
                        if (!route.activate || next.origin === api.origin) back();
                      }}
                    />
                  </WorkspacePage>
                );
              case "security":
                return user && <Security api={api} onBack={back} />;
              case "about":
                return <About api={api} onBack={back} />;
              case "default-route":
                return (
                  <DefaultRoute
                    api={api}
                    channels={outboundChannels()}
                    onBack={back}
                    onSaved={back}
                  />
                );
              case "history":
                return (
                  <History
                    api={api}
                    onOpen={(id) => open({ name: "message", id })}
                  />
                );
              case "message":
                return (
                  <MessageDetail
                    api={api}
                    speech={speech}
                    channels={channels()}
                    id={route.id}
                    onBack={back}
                    onReplay={
                      accountAdmin()
                        ? (id) => open({ name: "message", id })
                        : undefined
                    }
                  />
                );
              case "remote-message": {
                const remote = props.sessions.find((item) => item.api.origin === route.origin && !item.expired());
                return remote
                  ? <MessageDetail api={remote.api} channels={remote.channels()} speech={speech} id={route.id} onBack={back} />
                  : <WorkspacePage title={t("history.delivery_details")} back={back}>
                      <Action label={t("servers.sign_in")} onPress={() => selectServer(route.origin)} />
                    </WorkspacePage>;
              }
              case "inbox":
                return <If when={inbox()}>{(state) =>
                  <Inbox state={state()} notifications={props.notifications}
                    onNotificationSettings={() => open({ name: "notifications" })}
                    onOpen={(id) => open({ name: "inbox-detail", id })}
                    onSend={() => open({ name: "inbox-send" })} />
                }</If>;
              case "inbox-detail":
                return <If when={inbox()}>{(state) =>
                  <InboxDetail api={api} state={state()} speech={speech} id={route.id} onBack={back}
                    onReply={(recipient) => open({ name: "inbox-send", recipient })} />
                }</If>;
              case "inbox-send":
                return (
                  <InboxSend
                    api={api}
                    draft={inboxDraftFor(route.recipient)}
                    canSendSpeech={globalAdmin()}
                    onBack={back}
                    onDelivery={(id) => open({ name: "message", id })}
                  />
                );
            }
          }}
        </NavStack>
        <If when={!wide()}>
          <View
            role="navigation"
            class="gap-0.5 border-t border-border bg-sidebar px-1 pb-[env(safe-area-inset-bottom)]"
          >
            <If
              when={systemTabs}
              else={<View class="flex-row gap-0.5">{links()}</View>}
            >
              <TabBar
                items={enabledSections().map((tab) => ({
                  title: tab.title(),
                  icon: platform.os === "ios" ? tab.ios : tab.android,
                  badge: badge(tab.id),
                }))}
                selectedIndex={enabledSections().findIndex(
                  (tab) => tab.id === activeSection(),
                )}
                onChange={({ index }) => {
                  const tab = enabledSections()[index];
                  if (tab) go(tab.id);
                }}
              />
            </If>

          </View>
        </If>
      </View>
      <If when={user && showProfile()}>
        <Profile
          api={api}
          username={user!.username}
          profile={profile}
          onBack={() => showProfile.set(false)}
        />
      </If>
    </View>
  );
}

function navigationTip(label: string) {
  return (
    <Tooltip
      placement="right"
      startingClass="opacity-0"
      endingClass="opacity-0"
      class="rounded-(--radius) border border-border bg-popover px-2 py-1 shadow-sm transition-opacity duration-100 motion-reduce:transition-none"
    >
      <Text class="text-sm text-popover-foreground">{label}</Text>
    </Tooltip>
  );
}
