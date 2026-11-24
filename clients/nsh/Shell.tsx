import { t } from "nsh/i18n";
import {
  cleanup,
  effect,
  Image,
  platform,
  resource,
  signal,
  Text,
  UrlScheme,
  View,
  windowSize,
  type ImageAsset,
} from "nsh";
import { Button, createNavStack, NavStack } from "nsh/base";
import { currentWindow, isAvailable as desktopAvailable } from "nsh/desktop";
import { TabBar } from "nsh/mobile";
import { messageFor, type AnserApi } from "./api";
import accountIcon from "./assets/navigation/id-badge.svg";
import historyIcon from "./assets/navigation/history.svg";
import inboxIcon from "./assets/navigation/inbox.svg";
import preferencesIcon from "./assets/navigation/settings.svg";
import sendIcon from "./assets/navigation/send.svg";
import tagIcon from "./assets/navigation/tag.svg";
import { SpeechPlayer, speechPlayback } from "./components/Speech";
import { Action, confirm, Hint } from "./components/Controls";
import { AccountMenu } from "./components/AccountMenu";
import { Brand, WorkspacePage } from "./components/Workspace";
import { PreferenceControls } from "./components/Preferences";
import { createPreferences, type Preferences } from "./preferences";
import type { Account, Channel, ProxyProfile, Topic, User } from "./contracts";
import { inboxState } from "./inbox";
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

type Session = { api: AnserApi; channels: Channel[]; user?: User };

type Section = "compose" | "topics" | "accounts" | "history" | "inbox";

type Route =
  | { name: "compose"; topic?: Topic }
  | { name: "topics" }
  | { name: "topic"; topic: Topic }
  | { name: "topic-editor"; topic?: Topic }
  | { name: "default-route" }
  | { name: "preferences" }
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
    title: () => t("shell.accounts"),
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
];

export function AnserApp() {
  const preferences = createPreferences();
  if (desktopAvailable || platform.os === "web") {
    const appWindow = currentWindow();
    effect(() => appWindow.set({ title: t("workspace.anser") }));
  }
  const session = signal<Session | undefined>(undefined);
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
    session()?.api.close();
  });

  function connected(api: AnserApi, channels: Channel[], user?: User) {
    pairing.set(undefined);
    linkError.set("");
    session.set({ api, channels, user });
  }

  async function signOut(keepPairing = false) {
    const current = session();
    if (!current || disconnecting()) return;
    disconnecting.set(true);
    if (!keepPairing) pairing.set(undefined);
    // Remove local session, screens, and notification previews immediately.
    session.set(undefined);
    if (current.user)
      void current.api
        .logout()
        .catch(() => undefined)
        .finally(() => current.api.close());
    else current.api.close();
    disconnecting.set(false);
  }

  return (
    <View class="flex-1 bg-background" testID="app-background">
      <If when={preferences.ready()}>
        <If
          when={session()}
          else={
            <Connection
              preferences={preferences}
              pairing={pairing()}
              linkError={linkError()}
              onConnect={connected}
            />
          }
        >
          {(active) => (
            <Workspace
              preferences={preferences}
              session={active()}
              onDisconnect={signOut}
              pendingPairing={pairing()}
              onDismissPairing={() => pairing.set(undefined)}
            />
          )}
        </If>
      </If>
    </View>
  );
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
  preferences: Preferences;
  onDisconnect: (keepPairing?: boolean) => void;
  pendingPairing?: Pairing;
  onDismissPairing: () => void;
}) {
  const { api, user } = props.session;
  const profile = resource(Boolean(user), (_, { signal }) =>
    api.profile(signal),
  );
  const showProfile = signal(false);
  const displayName = () => profile()?.nickname || user?.username || "";
  const serverName = api.origin.replace(/^https:\/\//, "");
  const channels = signal(props.session.channels);
  const accountsRevision = signal(0);
  const proxyRevision = signal(0);
  const nav = createNavStack<Route>([{ name: "compose" }]);
  const draftFor = sessionDrafts(composeDraft);
  const inboxDraftFor = sessionDrafts(inboxDraft);
  const selection = signal<Section>("compose");
  const systemTabs = platform.os === "ios" || platform.os === "android";
  const wide = () => !systemTabs && windowSize().width >= 780;
  const accountAdmin = user?.admin ?? true;
  const globalAdmin = () => {
    const permissions = channels().filter(
      (channel) => channel.can_manage !== undefined,
    );
    return permissions.length
      ? permissions.some((channel) => channel.can_manage)
      : user?.admin === true;
  };
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
  const go = (tab: Section) => {
    if (selection() !== tab || nav.routes().length !== 1) {
      selection.set(tab);
      nav.setRoutes([{ name: tab }]);
    }
  };
  const speech = speechPlayback(api.origin);
  const inbox = user
    ? inboxState(api, (id) => {
        go("inbox");
        open({ name: "inbox-detail", id });
      }, speech.received)
    : undefined;
  const enabledSections = sections.filter(
    (tab) =>
      (tab.id !== "inbox" || Boolean(inbox)) &&
      (tab.id !== "accounts" || accountAdmin),
  );

  const badge = (tab: Section) => {
    const count = tab === "inbox" ? (inbox?.unread() ?? 0) : 0;
    return count ? (count > 99 ? "99+" : String(count)) : undefined;
  };

  const links = () => (
    <Each of={enabledSections} key={(tab) => tab.id}>
      {(tab) => {
        const selected = () => selection() === tab().id;
        return (
          <Button
            onPress={() => go(tab().id)}
            selected={selected()}
            class={`min-h-12 rounded-lg items-center hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring transition-colors duration-100 motion-reduce:transition-none ${wide() ? "flex-row gap-2.5 px-3 py-2" : "min-w-0 flex-1 justify-center gap-0.5 px-1 py-1"} ${selected() ? "bg-accent" : ""}`}
          >
            <Image
              src={tab().icon}
              class="size-6 shrink-0"
              fadeDuration={0}
              accessibilityElementsHidden
            />
            <Text
              class={`${wide() ? "text-sm" : "text-center text-xs"} ${selected() ? "font-semibold text-accent-foreground" : "text-foreground"}`}
            >
              {tab().title()}
              {badge(tab().id) ? ` (${badge(tab().id)})` : ""}
            </Text>
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
              label={t("shell.switch_server")}
              onPress={() =>
                void confirm(
                  t("shell.disconnect_from_the_current_server"),
                  invite().origin,
                  t("shell.switch_server"),
                  false,
                )
                  .then((accepted) => {
                    if (accepted) props.onDisconnect(true);
                  })
                  .catch(() => undefined)
              }
            />
            <Action
              label={t("shell.ignore")}
              kind="quiet"
              onPress={props.onDismissPairing}
            />
          </View>
        )}
      </If>
      <SpeechPlayer state={speech} />
      <View class={wide() ? "flex-1 flex-row" : "flex-1"}>
        <If when={wide()}>
          <View
            role="navigation"
            class="w-52 gap-5 border-r border-border bg-sidebar px-3 pt-5 pb-4"
          >
            <Brand compact />
            <View class="gap-1">{links()}</View>
            <View class="flex-1" />
            <View class="gap-1 border-t border-border pt-3">
              <If
                when={user}
                else={
                  <View class="gap-1 px-3 pb-2">
                    <Hint>{t("shell.api_key_session")}</Hint>
                    <Text
                      accessibilityLabel={api.origin}
                      class="line-clamp-2 text-sm text-muted-foreground"
                    >
                      {serverName}
                    </Text>
                  </View>
                }
              >
                <AccountMenu
                  name={displayName()}
                  avatar={profile()?.avatar}
                  server={serverName}
                  onProfile={() => showProfile.set(true)}
                  onSecurity={() => open({ name: "security" })}
                />
              </If>
              <Action
                label={t("preferences.title")}
                icon={preferencesIcon}
                onPress={openPreferences}
                kind="quiet"
                class="self-start"
              />
              <Action
                label={t("shell.disconnect")}
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
                    channels={channels()}
                    draft={draftFor(route.topic?.name)}
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
                    channels={channels()}
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
                    channels={channels()}
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
                    admin={accountAdmin}
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
                    admin={accountAdmin}
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
                    channels={channels()}
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
                    <Action
                      label={t("about.title")}
                      class="self-start"
                      onPress={() => open({ name: "about" })}
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
                    channels={channels()}
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
                    channels={channels()}
                    id={route.id}
                    onBack={back}
                    onReplay={
                      accountAdmin
                        ? (id) => open({ name: "message", id })
                        : undefined
                    }
                  />
                );
              case "inbox":
                return (
                  inbox && (
                    <Inbox
                      state={inbox}
                      speech={speech}
                      onOpen={(id) => open({ name: "inbox-detail", id })}
                      onSend={() => open({ name: "inbox-send" })}
                    />
                  )
                );
              case "inbox-detail":
                return (
                  inbox && (
                    <InboxDetail
                      api={api}
                      state={inbox}
                      speech={speech}
                      id={route.id}
                      onBack={back}
                      onReply={(recipient) =>
                        open({ name: "inbox-send", recipient })
                      }
                    />
                  )
                );
              case "inbox-send":
                return (
                  <InboxSend
                    api={api}
                    draft={inboxDraftFor(route.recipient)}
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
                items={enabledSections.map((tab) => ({
                  title: tab.title(),
                  icon: platform.os === "ios" ? tab.ios : tab.android,
                  badge: badge(tab.id),
                }))}
                selectedIndex={enabledSections.findIndex(
                  (tab) => tab.id === selection(),
                )}
                onChange={({ index }) => {
                  const tab = enabledSections[index];
                  if (tab) go(tab.id);
                }}
              />
            </If>
            <View class="flex-row items-center gap-2 px-3">
              <If
                when={user}
                else={
                  <Text class="line-clamp-1 flex-1 text-[13px] text-muted-foreground">
                    {serverName}
                  </Text>
                }
              >
                <AccountMenu
                  name={displayName()}
                  avatar={profile()?.avatar}
                  onProfile={() => showProfile.set(true)}
                  onSecurity={() => open({ name: "security" })}
                />
              </If>
              <Action
                label={t("preferences.title")}
                icon={preferencesIcon}
                onPress={openPreferences}
                kind="quiet"
              />
              <Action
                label={t("shell.disconnect_2")}
                onPress={() => props.onDisconnect()}
                kind="quiet"
              />
            </View>
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
