import { t } from "nsh/i18n";
import { AboutContent } from "./About";
import { cleanup, effect, Scroll, signal, Text, View } from "nsh";
import { AnserApi, ApiError, validateOrigin } from "../api";
import type { Channel, User } from "../contracts";
import type { Pairing } from "../pairing";
import { parsePairing } from "../pairing";
import {
  Action,
  Choice,
  confirm,
  Field,
  Hint,
  Panel,
  Problem,
} from "../components/Controls";
import { Brand } from "../components/Workspace";
import { operation } from "../state";
import { PreferenceControls } from "../components/Preferences";
import { ServerProfiles } from "../components/ServerProfiles";
import type { Preferences } from "../preferences";
import { serverLabel, type Servers } from "../servers";

type AuthMethod = "password" | "key" | "pairing";

function canonicalOrigin(value: string) {
  try {
    return validateOrigin(value);
  } catch {
    return undefined;
  }
}

export function Connection(props: {
  preferences: Preferences;
  servers: Servers;
  initialOrigin?: string;
  embedded?: boolean;
  pairing?: Pairing;
  replacing?: boolean;
  linkError?: string;
  onPairingHandled?: (invitation: Pairing) => void;
  onConnect: (api: AnserApi, channels: Channel[], user?: User, catalogUnavailable?: boolean, authMethod?: AuthMethod) => void;
}) {
  const initialOrigin = props.initialOrigin ?? props.servers.last() ?? props.servers.items()[0]?.origin ?? "";
  const address = signal(initialOrigin);
  const chosenOrigin = signal<string | undefined>(initialOrigin);
  const managing = signal(false);
  const showSavedServers = () => !props.embedded && props.servers.items().length > 0 && !pair()?.code;
  const saved = () => props.servers.items().some((item) => item.origin === chosenOrigin());
  const method = signal<"password" | "key">("password");
  const username = signal("");
  const key = signal("");
  const password = signal("");
  const verificationCode = signal("");
  const challenge = signal(false);
  const link = signal("");
  const pair = signal<Pairing | undefined>(undefined);
  const showImport = signal(false);
  const showPreferences = signal(false);
  const showAbout = signal(false);
  const connect = operation();
  const canSubmit = () => Boolean(address().trim() && (
    method() === "key" ? key().trim() : username().trim() && password() &&
      (!challenge() || verificationCode().trim())
  ));
  let pending: AnserApi | undefined;
  let seenPairing: Pairing | undefined;
  cleanup(() => pending?.close());
  effect(() => {
    const imported = props.pairing;
    if (!imported || imported === seenPairing || connect.busy()) return;
    seenPairing = imported;
    usePairing(imported);
    if (!imported.code) props.onPairingHandled?.(imported);
  });

  function usePairing(imported: Pairing) {
    changeAddress(imported.origin);
    chosenOrigin.set(imported.origin);
    if (imported.code) resetCredentials();
    pair.set(imported.code ? imported : undefined);
    link.set("");
    showImport.set(false);
    managing.set(false);
  }

  function choose(origin: string) {
    if (connect.busy()) return;
    changeAddress(origin);
    chosenOrigin.set(origin);
    managing.set(false);
  }

  function changeAddress(value: string) {
    const previous = address();
    if (value === previous) return;
    const nextOrigin = canonicalOrigin(value);
    if (!nextOrigin || nextOrigin !== canonicalOrigin(previous)) resetCredentials();
    address.set(value);
    connect.problem.set("");
  }

  function resetCredentials() {
    username.set("");
    password.set("");
    key.set("");
    resetChallenge();
  }

  function resetChallenge() {
    challenge.set(false);
    verificationCode.set("");
  }

  function credentialChanged(set: (value: string) => void, value: string) {
    if (connect.busy()) return;
    set(value);
    resetChallenge();
    connect.problem.set("");
  }

  function submit(withCode = false) {
    void connect.run(async () => {
      const invitation = withCode ? pair() : undefined;
      if (withCode ? !invitation?.code : !canSubmit()) return;
      const loginMethod = invitation ? "pairing" : method();
      const origin = validateOrigin(invitation?.origin ?? address());
      const loginName = username().trim();
      const loginPassword = password();
      const loginKey = key().trim();
      const loginCode = challenge() ? verificationCode().trim() : undefined;
      const pairingCode = invitation?.code;
      const replacing = props.replacing;

      if (pairingCode || replacing) {
        const accepted = await confirm(
          t(replacing ? "connection.replace_existing_sign_in" : "connection.connect_using_a_pairing_code"),
          origin,
          t(replacing ? "connection.replace_sign_in" : "connection.connect_to_this_server"),
          Boolean(replacing),
        );
        if (!accepted || !connect.live()) return;
      }

      let user: User | undefined;
      let api: AnserApi;
      if (loginMethod !== "key") {
        const publicApi = new AnserApi(origin, undefined);
        pending = publicApi;
        const signed = await (
          pairingCode
            ? publicApi.exchange(pairingCode)
            : publicApi.login(loginName, loginPassword, loginCode)
        )
          .catch((error: unknown) => {
            if (
              !withCode &&
              connect.live() &&
              error instanceof ApiError &&
              error.code === "totp_required"
            ) {
              challenge.set(true);
            }
            verificationCode.set("");
            throw error;
          })
          .finally(() => {
            publicApi.close();
            if (pending === publicApi) pending = undefined;
          });
        if (!connect.live()) return;
        resetChallenge();
        user = signed.user;
        api = new AnserApi(publicApi.origin, signed.token);
      } else {
        api = new AnserApi(origin, loginKey);
      }
      pending = api;
      try {
        let catalogUnavailable = false;
        const channels = await api.channels().catch((error: unknown) => {
          // The successful exchange consumed a one-time code. Keep the session
          // and retry the catalog independently when it could not load.
          if (loginMethod === "key" || (error instanceof ApiError && error.status === 401))
            throw error;
          catalogUnavailable = true;
          return [];
        });
        if (!connect.live()) return;
        if (!user) user = await api.me().catch(() => undefined);
        if (!connect.live()) return;
        pending = undefined;
        resetCredentials();
        pair.set(undefined);
        if (invitation) props.onPairingHandled?.(invitation);
        props.onConnect(api, channels, user, catalogUnavailable, loginMethod);
      } finally {
        if (pending === api) {
          pending = undefined;
          api.close();
        }
      }
    });
  }

  function importLink() {
    void connect.run(async () => usePairing(parsePairing(link())));
  }

  function dismissPairing() {
    const invitation = pair();
    if (invitation) props.onPairingHandled?.(invitation);
    pair.set(undefined);
    connect.problem.set("");
  }

  const content = () => (
      <View class={props.embedded ? "w-full max-w-lg self-center gap-4" : "w-full max-w-lg self-center gap-5 px-4 pt-8 pb-10 md:gap-5 md:px-6 md:pt-10"}>
        <If when={!props.embedded}><Brand /></If>
        <If when={managing()}>
          <ServerProfiles
            servers={props.servers}
            selected={address()}
            onChoose={choose}
            onChange={(previous, next) => { if (address() === previous) choose(next); }}
          />
          <View class="flex-row flex-wrap gap-2">
            <Action label={t("workspace.back")} kind="quiet" onPress={() => managing.set(false)} />
            <Action label={t("servers.connect_another")} onPress={() => choose("")} />
          </View>
        </If>
        <If when={!managing()}>
        <Panel>
          <Text role="header" class="text-[22px] font-semibold text-foreground">
            {t("connection.connect_to_an_anser_server")}
          </Text>
          <If when={!props.embedded && !pair()?.code}>
            <View class="flex-row flex-wrap items-center gap-2">
              <Action
                label={t(showImport() ? "connection.hide_link_import" : "connection.import_connection_link")}
                kind="quiet"
                onPress={() => showImport.update((value) => !value)}
                disabled={connect.busy()}
              />
              <Action
                label={t("servers.manage")}
                accessibilityLabel={t("servers.title")}
                kind="quiet"
                onPress={() => managing.set(true)}
                disabled={connect.busy()}
              />
            </View>
          </If>
          <Problem message={connect.problem() || props.linkError || ""} />
          <If when={showImport() && !pair()?.code}>
            <View class="gap-2 rounded-(--radius) border border-border bg-muted p-3">
              <Hint>{t("connection.scan_the_pairing_qr_code_with")}</Hint>
              <Field
                label={t("connection.connection_link")}
                value={link()}
                onChange={link.set}
                onSubmit={importLink}
                placeholder="anser://connect?server=…"
                disabled={connect.busy()}
                masked
              />
              <Action
                label={t("connection.preview_server")}
                onPress={importLink}
                class="self-start"
                disabled={connect.busy() || !link().trim()}
              />
            </View>
          </If>
          <If when={showSavedServers()}>
            <Choice
              label={t("servers.title")}
              value={saved() ? address() : ""}
              items={[
                ...props.servers.items().map(({ origin }) => ({ value: origin, title: props.servers.label(origin) })),
                { value: "", title: t("servers.connect_another") },
              ]}
              disabled={connect.busy()}
              onChange={(value) => choose(value ?? "")}
            />
          </If>
          <If when={!saved() && !pair()?.code}>
          <Field
            label={t("connection.server_address")}
            keyboard="url"
            value={address()}
            onChange={(value) => {
              if (connect.busy()) return;
              chosenOrigin.set(undefined);
              changeAddress(value);
            }}
            placeholder="https://anser.example.com"
            testID="server-address"
            disabled={connect.busy()}
          />
          </If>
          <If when={saved() && !showSavedServers() && !pair()?.code}>
            <Text class="text-base font-semibold text-foreground">{props.servers.label(address())}</Text>
          </If>
          <If
            when={pair()?.code}
            else={
              <View class="gap-3">
                <Choice
                  label={t("connection.sign_in_method")}
                  value={method()}
                  onChange={(value) => {
                    method.set(value === "key" ? "key" : "password");
                    key.set("");
                    password.set("");
                    resetChallenge();
                    connect.problem.set("");
                  }}
                  items={[
                    {
                      value: "password",
                      title: t("connection.username_and_password"),
                    },
                    { value: "key", title: t("common.api_key") },
                  ]}
                  disabled={connect.busy()}
                />
                <If
                  when={method() === "password"}
                  else={
                    <Field
                      label={t("common.api_key")}
                      value={key()}
                      onChange={key.set}
                      onSubmit={() => submit()}
                      masked
                      placeholder={t("connection.enter_an_api_key_issued_by")}
                      testID="api-key"
                      disabled={connect.busy()}
                    />
                  }
                >
                  <View class="gap-3">
                    <Field
                      label={t("connection.username")}
                      value={username()}
                      onChange={(value) =>
                        credentialChanged(username.set, value)
                      }
                      testID="username"
                      disabled={connect.busy()}
                    />
                    <Field
                      label={t("connection.password")}
                      value={password()}
                      onChange={(value) =>
                        credentialChanged(password.set, value)
                      }
                      onSubmit={() => {
                        if (!challenge()) submit();
                      }}
                      masked
                      testID="password"
                      disabled={connect.busy()}
                    />
                    <If when={challenge()}>
                      <Field
                        label={t("security.verification_or_recovery_code")}
                        value={verificationCode()}
                        onChange={verificationCode.set}
                        onSubmit={() => {
                          if (verificationCode().trim()) submit();
                        }}
                        masked
                        testID="verification-code"
                        disabled={connect.busy()}
                      />
                    </If>
                  </View>
                </If>
                <Hint>
                  {t("connection.your_credentials_are_kept_for_this")}
                </Hint>
                <Action
                  label={
                    connect.busy()
                      ? t("connection.connecting")
                      : t("connection.connect")
                  }
                  kind="primary"
                  onPress={() => submit()}
                  disabled={connect.busy() || !canSubmit()}
                />
              </View>
            }
          >
            <View class="gap-3">
              <View selectable class="min-w-0 gap-1">
                <Text class="text-base font-semibold text-foreground">{pair()?.origin}</Text>
                <If when={pair()?.origin && props.servers.label(pair()!.origin) !== serverLabel(pair()!.origin)}>
                  <Hint>{props.servers.label(pair()!.origin)}</Hint>
                </If>
              </View>
              <Hint>{t("connection.confirm_that_you_trust_this_server")}</Hint>
              <Action
                label={t("connection.connect_using_pairing_code")}
                kind="primary"
                onPress={() => submit(true)}
                disabled={connect.busy()}
              />
              <Action
                label={t("connection.use_another_sign_in_method")}
                kind="quiet"
                onPress={dismissPairing}
                disabled={connect.busy()}
              />
            </View>
          </If>
        </Panel>
        <If when={!props.embedded}>
        <Action
          label={t("preferences.title")}
          kind="quiet"
          class="self-start"
          onPress={() => showPreferences.update((value) => !value)}
        />
        <If when={showPreferences()}>
          <PreferenceControls preferences={props.preferences} />
          <Action
            label={t("about.title")}
            kind="quiet"
            class="self-start"
            onPress={() => showAbout.update((value) => !value)}
          />
          <If when={showAbout()}>
            <AboutContent />
          </If>
        </If>
        </If>
        </If>
      </View>
  );
  return props.embedded
    ? content()
    : <Scroll class="flex-1 bg-background" keyboardDismissMode="on-drag">{content()}</Scroll>;
}
