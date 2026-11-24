import { cleanup, effect, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { ApiError, type AnserApi } from "../api";
import {
  Action,
  Choice,
  confirm,
  Field,
  Hint,
  Panel,
  Problem,
  ReadState,
  Toggle,
} from "../components/Controls";
import { RecordRow, WorkspacePage } from "../components/Workspace";
import type { ProxyProfile, ProxyProfileInput } from "../contracts";
import { operation, paged } from "../state";

function proxyOrigin(value: string) {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.href.includes("?") &&
      !url.href.includes("#")
    )
      return url.origin;
  } catch {
    // Report the same validation error for malformed URLs and unsupported components.
  }
  throw new ApiError("invalid_proxy", t("proxies.invalid_origin"));
}

export function ProxyProfiles(props: {
  api: AnserApi;
  revision: number;
  onBack: () => void;
  onOpen: (profile: ProxyProfile) => void;
  onCreate: () => void;
}) {
  const list = paged(props.api.proxies.bind(props.api));
  let revision = props.revision;
  effect(() => {
    const next = props.revision;
    if (next !== revision) {
      revision = next;
      void list.reload();
    }
  });

  return (
    <WorkspacePage title={t("proxies.title")} back={props.onBack}>
      <View class="flex-row flex-wrap justify-between gap-2">
        <Action
          label={t("common.refresh")}
          kind="quiet"
          onPress={list.reload}
          disabled={list.loading()}
        />
        <Action
          label={t("proxies.add")}
          kind="primary"
          onPress={props.onCreate}
        />
      </View>
      <ReadState
        loading={list.loading()}
        problem={list.problem()}
        empty={!list.items().length}
        emptyLabel={t("proxies.empty")}
      />
      <Each of={list.items()} key={(profile) => profile.id}>
        {(profile) => (
          <RecordRow
            title={profile().name}
            subtitle={profile().url}
            status={
              <If when={profile().authenticated}>
                <Text class="text-sm text-muted-foreground">
                  {t("proxies.authenticated")}
                </Text>
              </If>
            }
            onPress={() => props.onOpen(profile())}
          />
        )}
      </Each>
      <If when={list.next()}>
        <Action
          label={t("common.load_more")}
          onPress={list.more}
          disabled={list.loading()}
        />
      </If>
    </WorkspacePage>
  );
}

export function ProxyEditor(props: {
  api: AnserApi;
  profile?: ProxyProfile;
  onBack: () => void;
  onSaved: () => void;
}) {
  const original = props.profile;
  const name = signal(original?.name ?? "");
  const origin = signal(original?.url ?? "");
  const replace = signal(!original);
  const authenticated = signal(original?.authenticated ?? false);
  const username = signal("");
  const password = signal("");
  const action = operation();
  const probe = operation();
  const probeResult = signal<{ status: number; latency_ms: number } | undefined>(undefined);
  const busy = () => action.busy() || probe.busy();

  function clearProbe() {
    probe.problem.set("");
    probeResult.set(undefined);
  }

  function clearCredentials() {
    username.set("");
    password.set("");
  }

  cleanup(clearCredentials);

  function connection() {
    const url = proxyOrigin(origin());
    if (!authenticated()) return { url };
    if (!username().trim() || !password())
      throw new ApiError("invalid_proxy_auth", t("proxies.auth_required"));
    return { url, username: username(), password: password() };
  }

  function save() {
    void action.run(async () => {
      if (!name().trim()) return;
      const input: ProxyProfileInput = { name: name().trim(), ...(replace() ? connection() : {}) };
      await props.api.saveProxy(original?.id, input);
      if (action.live()) {
        clearCredentials();
        props.onSaved();
      }
    });
  }

  function testConnection() {
    clearProbe();
    void probe.run(async () => {
      let result;
      if (replace()) {
        const { url, ...credentials } = connection();
        result = await props.api.probeProxy(undefined, { proxy_url: url, ...credentials });
      } else {
        result = await props.api.probeProxy(original?.id, {});
      }
      if (probe.live()) probeResult.set(result);
    });
  }

  function remove() {
    if (!original) return;
    void action.run(async () => {
      const accepted = await confirm(
        t("proxies.confirm_delete", { name: original.name }),
        t("proxies.delete_hint"),
        t("proxies.delete"),
      );
      if (!accepted || !action.live()) return;
      await props.api.deleteProxy(original.id);
      if (action.live()) props.onSaved();
    });
  }

  return (
    <WorkspacePage
      title={t(original ? "proxies.edit" : "proxies.add")}
      back={props.onBack}
      footer={
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={action.busy() ? t("common.saving") : t("proxies.save")}
            kind="primary"
            onPress={save}
            disabled={!name().trim() || busy()}
          />
          <Action
            label={t("common.cancel")}
            kind="quiet"
            onPress={props.onBack}
            disabled={busy()}
          />
        </View>
      }
    >
      <Problem message={action.problem()} />
      <Panel>
        <Field
          label={t("proxies.name")}
          value={name()}
          onChange={name.set}
          disabled={busy()}
        />
        <If when={original}>
          <Toggle
            label={t("proxies.replace")}
            checked={replace()}
            disabled={busy()}
            onChange={(value) => {
              clearProbe();
              replace.set(value);
              if (!value) {
                clearCredentials();
                origin.set(original?.url ?? "");
                authenticated.set(original?.authenticated ?? false);
              }
            }}
          />
          <If when={!replace()}>
            <Hint>{t("proxies.current_origin", { url: original?.url })}</Hint>
            <If when={original?.authenticated}>
              <Hint>{t("proxies.saved_auth")}</Hint>
            </If>
          </If>
        </If>
        <If when={replace()}>
          <Field
            label={t("proxies.origin")}
            value={origin()}
            onChange={(value) => { clearProbe(); origin.set(value); }}
            placeholder="https://proxy.example.com:8443"
            disabled={busy()}
            keyboard="url"
          />
          <Toggle
            label={t("proxies.use_auth")}
            checked={authenticated()}
            disabled={busy()}
            onChange={(value) => {
              clearProbe();
              authenticated.set(value);
              if (!value) clearCredentials();
            }}
          />
          <If when={authenticated()}>
            <Field
              label={t("proxies.username")}
              value={username()}
              onChange={(value) => { clearProbe(); username.set(value); }}
              disabled={busy()}
            />
            <Field
              label={t("proxies.password")}
              value={password()}
              onChange={(value) => { clearProbe(); password.set(value); }}
              masked
              disabled={busy()}
            />
          </If>
          <If when={original?.authenticated && !authenticated()}>
            <Hint>{t("proxies.remove_auth_hint")}</Hint>
          </If>
        </If>
        <Action
          label={probe.busy() ? t("proxies.testing") : t("proxies.test")}
          kind="secondary"
          class="self-start"
          disabled={busy() || (replace() && (!origin().trim() || (authenticated() && (!username().trim() || !password()))))}
          onPress={testConnection}
        />
        <Hint>{t("proxies.test_target")}</Hint>
        <Problem message={probe.problem()} />
        <If when={probeResult()}>
          {(result) => <Hint>{t("proxies.test_result", { status: result().status, ms: result().latency_ms })}</Hint>}
        </If>
      </Panel>
      <If when={original}>
        <Action
          label={t("proxies.delete")}
          kind="danger"
          onPress={remove}
          class="self-start"
          disabled={busy()}
        />
      </If>
    </WorkspacePage>
  );
}

export function ProxyPicker(props: {
  api: AnserApi;
  selected: string | null | undefined;
  canKeepExisting: boolean;
  onChange: (value: string | null | undefined) => void;
}) {
  const keepExisting = ":existing";
  const unsupported = signal(false);
  const list = paged(async (cursor, abort) => {
    try {
      return await props.api.proxies(cursor, abort);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        unsupported.set(true);
        return { items: [] };
      }
      throw error;
    }
  });
  const options = () => [
    ...(props.canKeepExisting
      ? [{ value: keepExisting, title: t("proxies.keep_existing") }]
      : []),
    { value: "", title: t("proxies.direct") },
    ...list
      .items()
      .map((profile) => ({ value: profile.id, title: profile.name })),
    ...(props.selected &&
    !list.items().some((profile) => profile.id === props.selected)
      ? [{ value: props.selected, title: t("proxies.current_profile") }]
      : []),
  ];

  return (
    <If when={!unsupported()}>
      <View class="gap-2">
        <Choice
          label={t("proxies.outbound")}
          value={
            props.selected === undefined && props.canKeepExisting
              ? keepExisting
              : (props.selected ?? "")
          }
          items={options()}
          onChange={(value) =>
            props.onChange(value === keepExisting ? undefined : value || null)
          }
        />
        <If when={props.selected}>
          <Hint>{t("proxies.shared_hint")}</Hint>
        </If>
        <Problem message={list.problem()} />
        <If when={list.loading()}>
          <Hint>{t("controls.loading")}</Hint>
        </If>
        <If when={list.problem()}>
          <Action
            label={t("common.refresh")}
            kind="quiet"
            onPress={list.reload}
            disabled={list.loading()}
            class="self-start"
          />
        </If>
        <If when={list.next()}>
          <Action
            label={t("common.load_more")}
            onPress={list.more}
            disabled={list.loading()}
            class="self-start"
          />
        </If>
      </View>
    </If>
  );
}
