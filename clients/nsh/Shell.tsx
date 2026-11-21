import { t } from "nsh/i18n";
import {
  cleanup,
  platform,
  signal,
  Text,
  UrlScheme,
  View,
  windowSize,
} from "nsh";
import { Button, createNavStack, NavStack } from "nsh/base";
import { TabBar } from "nsh/mobile";
import { messageFor, type AnserApi } from "./api";
import { Action, confirm, Hint } from "./components/Controls";
import { Brand, WorkspacePage } from "./components/Workspace";
import { PreferenceControls } from "./components/Preferences";
import { createPreferences, type Preferences } from "./preferences";
import type { Account, Channel, Topic, User } from "./contracts";
import { inboxState } from "./inbox";
import type { Pairing } from "./pairing";
import { parsePairing } from "./pairing";
import { AccountEditor, Accounts } from "./pages/Accounts";
import { Compose } from "./pages/Compose";
import { Connection } from "./pages/Connection";
import { DefaultRoute } from "./pages/DefaultRoute";
import { History, MessageDetail } from "./pages/History";
import { Inbox, InboxDetail, InboxSend } from "./pages/Inbox";
import { TopicDetail, TopicEditor, Topics } from "./pages/Topics";

type Session = { api: AnserApi; channels: Channel[]; user?: User };

type Section = "compose" | "topics" | "accounts" | "history" | "inbox";

type Route =
  | { name: "compose"; topic?: string }
  | { name: "topics" }
  | { name: "topic"; topic: Topic }
  | { name: "topic-editor"; topic?: Topic }
  | { name: "default-route" }
  | { name: "preferences" }
  | { name: "accounts" }
  | { name: "account-editor"; account?: Account }
  | { name: "history" }
  | { name: "message"; id: string }
  | { name: "inbox" }
  | { name: "inbox-detail"; id: number }
  | { name: "inbox-send" };

const sections: {
  id: Section;
  title: () => string;
  ios: string;
  android: string;
}[] = [
  {
    id: "compose",
    title: () => t("shell.send"),
    ios: "paperplane",
    android: "android:ic_menu_send",
  },
  {
    id: "topics",
    title: () => "Topic",
    ios: "tag",
    android: "android:ic_menu_agenda",
  },
  {
    id: "accounts",
    title: () => t("shell.accounts"),
    ios: "person.crop.circle",
    android: "android:ic_menu_manage",
  },
  {
    id: "history",
    title: () => t("shell.deliveries"),
    ios: "clock",
    android: "android:ic_menu_recent_history",
  },
  {
    id: "inbox",
    title: () => t("common.inbox"),
    ios: "tray",
    android: "android:ic_dialog_email",
  },
];

export function AnserApp() {
  const preferences = createPreferences();
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

function Workspace(props: {
  session: Session;
  preferences: Preferences;
  onDisconnect: (keepPairing?: boolean) => void;
  pendingPairing?: Pairing;
  onDismissPairing: () => void;
}) {
  const { api, channels, user } = props.session;
  const nav = createNavStack<Route>([{ name: "compose" }]);
  const selection = signal<Section>("compose");
  const systemTabs = platform.os === "ios" || platform.os === "android";
  const wide = () => !systemTabs && windowSize().width >= 780;
  const accountAdmin = user?.admin ?? true;
  const open = (page: Route) => nav.push(page);
  const back = () => nav.pop();
  const go = (tab: Section) => {
    if (selection() !== tab || nav.routes().length !== 1) {
      selection.set(tab);
      nav.setRoutes([{ name: tab }]);
    }
  };
  const inbox = user
    ? inboxState(api, (id) => {
        go("inbox");
        open({ name: "inbox-detail", id });
      })
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
      {(tab) => (
        <Button
          onPress={() => go(tab().id)}
          selected={selection() === tab().id}
          class={`min-h-11 rounded-md px-2.5 py-2 hover:bg-muted active:bg-accent selected:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${wide() ? "items-start" : "flex-1 items-center justify-center"}`}
        >
          <Text
            class={
              selection() === tab().id
                ? "text-sm font-semibold text-accent-foreground"
                : "text-sm text-foreground"
            }
          >
            {tab().title()}
            {badge(tab().id) ? ` (${badge(tab().id)})` : ""}
          </Text>
        </Button>
      )}
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
      <View class={wide() ? "flex-1 flex-row" : "flex-1"}>
        <If when={wide()}>
          <View
            role="navigation"
            class="w-48 gap-5 border-r border-border bg-sidebar px-3 pt-5 pb-4"
          >
            <Brand compact />
            <View class="gap-1">{links()}</View>
            <View class="flex-1" />
            <View class="gap-1 px-2">
              <Hint>{user?.username ?? t("shell.api_key_session")}</Hint>
              <Text class="line-clamp-2 text-[13px] text-muted-foreground">
                {api.origin}
              </Text>
            </View>
            <Action
              label={t("preferences.title")}
              onPress={() => open({ name: "preferences" })}
              kind="quiet"
            />
            <Action
              label={t("shell.disconnect")}
              kind="quiet"
              onPress={() => props.onDisconnect()}
            />
          </View>
        </If>
        <NavStack state={nav} class="min-w-0 flex-1">
          {(route) => {
            switch (route.name) {
              case "compose":
                return (
                  <Compose
                    api={api}
                    channels={channels}
                    initialTopic={route.topic}
                    onAccepted={(id) => open({ name: "message", id })}
                  />
                );
              case "accounts":
                return (
                  <Accounts
                    api={api}
                    channels={channels}
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
                    channels={channels}
                    account={route.account}
                    onBack={back}
                    onSaved={() => nav.setRoutes([{ name: "accounts" }])}
                    onDeleted={() => nav.setRoutes([{ name: "accounts" }])}
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
                      open({ name: "compose", topic: route.topic.name })
                    }
                  />
                );
              case "topic-editor":
                return (
                  <TopicEditor
                    api={api}
                    channels={channels}
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
                  </WorkspacePage>
                );
              case "default-route":
                return (
                  <DefaultRoute
                    api={api}
                    channels={channels}
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
                    channels={channels}
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
                      onOpen={(id) => open({ name: "inbox-detail", id })}
                      onSend={() => open({ name: "inbox-send" })}
                    />
                  )
                );
              case "inbox-detail":
                return (
                  inbox && (
                    <InboxDetail state={inbox} id={route.id} onBack={back} />
                  )
                );
              case "inbox-send":
                return <InboxSend api={api} onBack={back} />;
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
              <Text class="line-clamp-1 flex-1 text-[13px] text-muted-foreground">
                {user?.username ?? api.origin}
              </Text>
              <Action
                label={t("preferences.title")}
                onPress={() => open({ name: "preferences" })}
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
    </View>
  );
}
