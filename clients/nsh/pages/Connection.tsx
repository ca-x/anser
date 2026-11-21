import { t } from "nsh/i18n";
import { cleanup, effect, Scroll, signal, Text, View } from "nsh";
import { AnserApi, ApiError } from "../api";
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
import type { Preferences } from "../preferences";

export function Connection(props: {
  preferences: Preferences;
  pairing?: Pairing;
  linkError?: string;
  onConnect: (api: AnserApi, channels: Channel[], user?: User) => void;
}) {
  const address = signal("");
  const method = signal("password");
  const username = signal("");
  const key = signal("");
  const password = signal("");
  const verificationCode = signal("");
  const challenge = signal(false);
  const link = signal("");
  const pair = signal<Pairing | undefined>(undefined);
  const showImport = signal(false);
  const showPreferences = signal(false);
  const connect = operation();
  let pending: AnserApi | undefined;
  cleanup(() => pending?.close());
  effect(() => {
    const imported = props.pairing;
    if (imported) usePairing(imported);
  });

  function usePairing(imported: Pairing) {
    resetChallenge();
    address.set(imported.origin);
    pair.set(imported.code ? imported : undefined);
    link.set("");
    showImport.set(false);
  }

  function resetChallenge() {
    challenge.set(false);
    verificationCode.set("");
  }

  function credentialChanged(set: (value: string) => void, value: string) {
    set(value);
    resetChallenge();
    connect.problem.set("");
  }

  function submit(withCode = false) {
    void connect.run(async () => {
      const invitation = pair();
      if (withCode && !invitation?.code) return;
      if (
        withCode &&
        invitation &&
        !(await confirm(
          t("connection.connect_using_a_pairing_code"),
          invitation.origin,
          t("connection.connect_to_this_server"),
          false,
        ))
      )
        return;

      let user: User | undefined;
      let api: AnserApi;
      if ((withCode && invitation?.code) || method() === "password") {
        const publicApi = new AnserApi(
          withCode ? invitation!.origin : address(),
          undefined,
        );
        pending = publicApi;
        const signed = await (
          withCode && invitation?.code
            ? publicApi.exchange(invitation.code)
            : publicApi.login(
                username().trim(),
                password(),
                challenge() ? verificationCode().trim() : undefined,
              )
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
        api = new AnserApi(address(), key());
      }
      pending = api;
      try {
        const channels = await api.channels();
        if (!user) user = await api.me().catch(() => undefined);
        if (!connect.live()) return;
        pending = undefined;
        password.set("");
        key.set("");
        resetChallenge();
        pair.set(undefined);
        props.onConnect(api, channels, user);
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

  return (
    <Scroll class="flex-1 bg-background" keyboardDismissMode="on-drag">
      <View class="w-full max-w-lg self-center gap-5 px-4 pt-8 pb-10 md:gap-6 md:px-6 md:pt-16">
        <Brand />
        <Panel>
          <Text role="header" class="text-[22px] font-semibold text-foreground">
            {t("connection.connect_to_an_anser_server")}
          </Text>
          <Problem message={connect.problem() || props.linkError || ""} />
          <Field
            label={t("connection.server_address")}
            keyboard="url"
            value={address()}
            onChange={(value) => {
              credentialChanged(address.set, value);
              pair.set(undefined);
            }}
            placeholder="https://anser.example.com"
            testID="server-address"
            disabled={connect.busy()}
          />
          <If
            when={pair()?.code}
            else={
              <View class="gap-3">
                <Choice
                  label={t("connection.sign_in_method")}
                  value={method()}
                  onChange={(value) => {
                    method.set(value ?? "password");
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
                  disabled={
                    connect.busy() ||
                    !address().trim() ||
                    (method() === "key"
                      ? !key().trim()
                      : !username().trim() ||
                        !password() ||
                        (challenge() && !verificationCode().trim()))
                  }
                />
              </View>
            }
          >
            <View class="gap-3">
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
                onPress={() => pair.set(undefined)}
                disabled={connect.busy()}
              />
            </View>
          </If>
        </Panel>
        <Action
          label={
            showImport()
              ? t("connection.hide_link_import")
              : t("connection.import_connection_link")
          }
          kind="quiet"
          class="self-start"
          onPress={() => showImport.update((value) => !value)}
          disabled={connect.busy()}
        />
        <If when={showImport()}>
          <Panel>
            <Hint>{t("connection.scan_the_pairing_qr_code_with")}</Hint>
            <Field
              label={t("connection.connection_link")}
              value={link()}
              onChange={link.set}
              onSubmit={importLink}
              placeholder="anser://connect?server=…"
              masked
            />
            <Action
              label={t("connection.preview_server")}
              onPress={importLink}
              disabled={!link().trim()}
            />
          </Panel>
        </If>

        <Action
          label={t("preferences.title")}
          kind="quiet"
          class="self-start"
          onPress={() => showPreferences.update((value) => !value)}
        />
        <If when={showPreferences()}>
          <PreferenceControls preferences={props.preferences} />
        </If>
      </View>
    </Scroll>
  );
}
