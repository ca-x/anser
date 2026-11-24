import { signal, Text, View } from "nsh";
import { Button, Checkbox } from "nsh/base";
import { t } from "nsh/i18n";
import { messageFor } from "../api";
import { serverLabel, type ServerProfile, type Servers } from "../servers";
import { Action, confirm, Field, Hint, Panel, Problem, Section } from "./Controls";

export function ServerTags(props: {
  items: ServerProfile[];
  selected: string[];
  onToggle: (origin: string) => void;
  disabled?: boolean;
}) {
  return <SelectionTags
    items={props.items.map((item) => ({ id: item.origin, label: serverLabel(item.origin, item.name) }))}
    selected={props.selected} onToggle={props.onToggle} disabled={props.disabled} />;
}

export function SelectionTags(props: {
  items: { id: string; label: string }[];
  selected: string[];
  onToggle: (origin: string) => void;
  disabled?: boolean;
}) {
  return (
    <View class="flex-row flex-wrap gap-2">
      <Each of={props.items} key={(item) => item.id}>
        {(item) => {
          const selected = () => props.selected.includes(item().id);
          return (
            <Checkbox
              checked={selected()}
              accessibilityLabel={item().label}
              disabled={props.disabled}
              onChange={() => props.onToggle(item().id)}
              indicatorClass="size-4 shrink-0 items-center justify-center"
              indicator={
                <If when={selected()} else={
                  <View accessibilityElementsHidden class="size-3 rounded-full border border-input" />
                }>
                  <Text accessibilityElementsHidden class="text-accent-foreground">✓</Text>
                </If>
              }
              class={`min-h-11 max-w-full flex-row items-center gap-1.5 rounded-full border px-3 py-1.5 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 transition-colors duration-100 motion-reduce:transition-none ${selected() ? "border-primary bg-accent" : "border-border bg-card hover:bg-muted"}`}
            >
              <Text class={`line-clamp-1 min-w-0 text-sm font-medium ${selected() ? "text-accent-foreground" : "text-foreground"}`}>
                {item().label}
              </Text>
            </Checkbox>
          );
        }}
      </Each>
    </View>
  );
}

export function ServerProfiles(props: {
  servers: Servers;
  active?: string;
  selected?: string;
  isConnected?: (origin: string) => boolean;
  onChoose: (origin: string) => void;
  onConnect?: (origin: string) => void;
  onChange?: (previous: string, origin: string) => void;
}) {
  const editor = signal<ServerProfile | undefined>();
  const origin = signal("");
  const name = signal("");
  const problem = signal("");

  function edit(profile: ServerProfile = { origin: "", name: "" }) {
    origin.set(profile.origin);
    name.set(profile.name);
    problem.set("");
    editor.set(profile);
  }

  function save(connect = false) {
    const entry = editor();
    if (!entry) return;
    try {
      const profile = props.servers.save(origin(), name(), entry.origin || undefined);
      if (entry.origin) props.onChange?.(entry.origin, profile.origin);
      if (connect) props.onConnect?.(profile.origin);
      editor.set(undefined);
    } catch (error) {
      problem.set(messageFor(error));
    }
  }

  async function remove(profile: ServerProfile) {
    if (!(await confirm(t("servers.remove_title"), serverLabel(profile.origin, profile.name), t("servers.remove"), true))) return;
    props.servers.remove(profile.origin);
    props.onChange?.(profile.origin, "");
    editor.set(undefined);
  }

  return (
    <If when={editor()} else={
      <View class="gap-5">
        <View class="flex-row items-center justify-between gap-3">
          <Text role="header" class="text-base font-semibold text-foreground">{t("servers.saved")}</Text>
          <Action label={t("servers.add")} kind="primary" onPress={() => edit()} />
        </View>
        <If when={!props.servers.items().length}><Hint>{t("servers.empty")}</Hint></If>
        <View class="gap-2">
          <Each of={props.servers.items()} key={(server) => server.origin}>
            {(server) => {
              const label = () => serverLabel(server().origin, server().name);
              const connected = () => Boolean(props.isConnected?.(server().origin));
              const active = () => props.active === server().origin;
              return (
                <View class="min-w-0 flex-row items-center gap-1 rounded-(--radius) border border-border bg-card p-1">
                  <Button
                    accessibilityLabel={t("servers.select_name", { name: label() })}
                    selected={active() || props.selected === server().origin}
                    class="min-h-12 min-w-0 flex-1 justify-center gap-0.5 rounded-(--radius) px-3 py-2 hover:bg-muted active:bg-accent selected:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    onPress={() => props.onChoose(server().origin)}
                  >
                    <Text class="line-clamp-1 text-sm font-semibold text-foreground">{label()}</Text>
                    <Text class="text-xs text-muted-foreground">
                      {t(active() ? "servers.current" : connected() ? "servers.connected" : "servers.not_connected")}
                    </Text>
                  </Button>
                  <Action
                    label={t("servers.edit_short")}
                    accessibilityLabel={t("servers.edit_name", { name: label() })}
                    kind="quiet"
                    onPress={() => edit(server())}
                  />
                </View>
              );
            }}
          </Each>
        </View>
        <If when={props.servers.items().length}>
          <Section title={t("servers.defaults")}>
            <Hint>{t("servers.defaults_hint")}</Hint>
            <ServerTags items={props.servers.items()} selected={props.servers.defaults()} onToggle={props.servers.toggleDefault} />
          </Section>
        </If>
        <If when={!props.servers.saved()}><Hint>{t("preferences.session_only")}</Hint></If>
      </View>
    }>
      {(entry) => (
        <Panel>
          <Text role="header" class="text-lg font-semibold text-foreground">
            {entry().origin ? t("servers.edit") : t("servers.add")}
          </Text>
          <Field label={t("servers.name")} value={name()} onChange={name.set} hint={t("servers.name_hint")} />
          <Field label={t("connection.server_address")} value={origin()} onChange={origin.set} keyboard="url" placeholder="https://anser.example.com" disabled={Boolean(props.isConnected?.(entry().origin))} />
          <If when={props.isConnected?.(entry().origin)}><Hint>{t("servers.address_connected")}</Hint></If>
          <Problem message={problem()} />
          <View class="flex-row flex-wrap justify-end gap-2">
            <If when={entry().origin && !props.isConnected?.(entry().origin)}>
              <Action label={t("servers.remove")} kind="danger" onPress={() => void remove(entry())} />
            </If>
            <Action label={t("common.cancel")} kind="quiet" onPress={() => editor.set(undefined)} />
            <Action label={t("servers.save")} kind={props.onConnect && !entry().origin ? "secondary" : "primary"}
              disabled={!origin().trim()} onPress={() => save()} />
            <If when={props.onConnect && !entry().origin}>
              <Action label={t("servers.save_and_sign_in")} kind="primary" disabled={!origin().trim()} onPress={() => save(true)} />
            </If>
          </View>
        </Panel>
      )}
    </If>
  );
}
