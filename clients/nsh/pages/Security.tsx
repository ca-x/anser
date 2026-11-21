import {
  announce,
  cleanup,
  Clipboard,
  resource,
  signal,
  Text,
  View,
} from "nsh";
import { t } from "nsh/i18n";
import { messageFor, type AnserApi } from "../api";
import {
  Action,
  Field,
  Hint,
  Panel,
  Problem,
  Section,
} from "../components/Controls";
import { localTime } from "../components/DeliveryStatus";
import { WorkspacePage } from "../components/Workspace";
import type { TotpSetup } from "../contracts";
import { operation } from "../state";

type Form =
  | { kind: "setup" }
  | { kind: "confirm"; secret: string; expiresAt: TotpSetup["expires_at"] }
  | { kind: "recovery"; codes: string[] }
  | { kind: "disable" };

export function Security(props: { api: AnserApi; onBack: () => void }) {
  const current = resource(({ signal }) => props.api.totpStatus(signal));
  const updated = signal<boolean | undefined>(undefined);
  const enabled = () => updated() ?? current()?.enabled;
  const form = signal<Form | undefined>(undefined);
  const setup = () => {
    const step = form();
    return step?.kind === "confirm" ? step : undefined;
  };
  const recovery = () => {
    const step = form();
    return step?.kind === "recovery" ? step.codes : undefined;
  };
  const password = signal("");
  const code = signal("");
  const copied = signal(false);
  const action = operation();
  const controller = new AbortController();
  cleanup(() => {
    controller.abort();
    password.set("");
    code.set("");
    form.set(undefined);
  });

  function show(next?: Form) {
    password.set("");
    code.set("");
    copied.set(false);
    action.problem.set("");
    form.set(next);
  }

  function submit() {
    void action.run(async () => {
      const step = form();
      if (step?.kind === "setup" && password()) {
        const pending = props.api.setupTotp(password(), controller.signal);
        password.set("");
        const { secret, expires_at } = await pending;
        if (action.live())
          show({ kind: "confirm", secret, expiresAt: expires_at });
      } else if (step?.kind === "confirm" && code().trim()) {
        const pending = props.api.confirmTotp(code().trim(), controller.signal);
        code.set("");
        const result = await pending;
        if (action.live()) {
          updated.set(result.enabled);
          show({ kind: "recovery", codes: result.recovery_codes });
        }
      } else if (step?.kind === "disable" && password() && code().trim()) {
        const pending = props.api.disableTotp(
          password(),
          code().trim(),
          controller.signal,
        );
        password.set("");
        code.set("");
        const result = await pending;
        if (action.live()) {
          updated.set(result.enabled);
          show();
        }
      }
    });
  }

  function copy(value: string) {
    void action.run(async () => {
      try {
        await Clipboard.writeText(value);
        if (!action.live()) return;
        copied.set(true);
        announce(t("security.copied"));
      } catch {
        if (action.live())
          action.problem.set(t("security.clipboard_unavailable"));
      }
    });
  }

  const passwordField = () => (
    <Field
      label={t("security.current_password")}
      value={password()}
      onChange={password.set}
      masked
      disabled={action.busy()}
      onSubmit={submit}
    />
  );
  const codeField = (recoveryAllowed: boolean) => (
    <Field
      label={t(
        recoveryAllowed
          ? "security.verification_or_recovery_code"
          : "security.authenticator_code",
      )}
      value={code()}
      onChange={code.set}
      onSubmit={submit}
      masked
      keyboard={recoveryAllowed ? "default" : "numeric"}
      disabled={action.busy()}
    />
  );
  const cancel = () => (
    <Action
      label={t("common.cancel")}
      kind="quiet"
      onPress={() => show()}
      disabled={action.busy()}
    />
  );

  return (
    <WorkspacePage title={t("security.title")} back={props.onBack}>
      <Section title={t("security.two_factor")}>
        <Panel>
          <Problem
            message={
              action.problem() ||
              (current.error() ? messageFor(current.error()) : "")
            }
          />
          <If
            when={enabled() !== undefined}
            else={
              <If
                when={current.error()}
                else={<Hint>{t("controls.loading")}</Hint>}
              >
                <Action
                  label={t("common.refresh")}
                  onPress={current.refetch}
                  disabled={current.state() === "refreshing"}
                />
              </If>
            }
          >
            <Text
              class={
                enabled()
                  ? "text-sm text-success"
                  : "text-sm text-muted-foreground"
              }
            >
              {t(enabled() ? "common.enabled" : "common.disabled")}
            </Text>
            <If
              when={form()}
              else={
                <View class="gap-2">
                  <Hint>
                    {t(
                      enabled()
                        ? "security.enabled_hint"
                        : "security.overview_hint",
                    )}
                  </Hint>
                  <Action
                    label={t(
                      enabled() ? "security.disable" : "security.enable",
                    )}
                    kind={enabled() ? "secondary" : "primary"}
                    class="self-start"
                    onPress={() =>
                      show({ kind: enabled() ? "disable" : "setup" })
                    }
                  />
                </View>
              }
            >
              {(step) => (
                <>
                  <If when={step().kind === "setup"}>
                    <Hint>{t("security.setup_password_hint")}</Hint>
                    {passwordField()}
                    <View class="flex-row flex-wrap gap-2">
                      <Action
                        label={t("security.continue")}
                        kind="primary"
                        onPress={submit}
                        disabled={!password() || action.busy()}
                      />
                      {cancel()}
                    </View>
                  </If>
                  <If when={setup()}>
                    {(pending) => (
                      <View class="gap-3">
                        <Hint>{t("security.manual_setup")}</Hint>
                        <Text class="text-base font-medium text-foreground">
                          {pending().secret}
                        </Text>
                        <Hint>
                          {t("security.expires_at", {
                            time: localTime(pending().expiresAt),
                          })}
                        </Hint>
                        <Action
                          label={t("security.copy_secret")}
                          onPress={() => copy(pending().secret)}
                          disabled={action.busy()}
                          class="self-start"
                        />
                        {codeField(false)}
                        <View class="flex-row flex-wrap gap-2">
                          <Action
                            label={t("security.verify")}
                            kind="primary"
                            onPress={submit}
                            disabled={!code().trim() || action.busy()}
                          />
                          {cancel()}
                        </View>
                      </View>
                    )}
                  </If>
                  <If when={recovery()}>
                    {(codes) => (
                      <View class="gap-3">
                        <Text
                          role="header"
                          class="text-base font-semibold text-foreground"
                        >
                          {t("security.recovery_codes")}
                        </Text>
                        <Hint>{t("security.recovery_hint")}</Hint>
                        <Text class="text-base text-foreground">
                          {codes().join("\n")}
                        </Text>
                        <View class="flex-row flex-wrap gap-2">
                          <Action
                            label={t("security.copy_recovery_codes")}
                            onPress={() => copy(codes().join("\n"))}
                            disabled={action.busy()}
                          />
                          <Action
                            label={t("security.done")}
                            kind="primary"
                            onPress={() => show()}
                            disabled={action.busy()}
                          />
                        </View>
                      </View>
                    )}
                  </If>
                  <If when={step().kind === "disable"}>
                    <Hint>{t("security.disable_hint")}</Hint>
                    {passwordField()}
                    {codeField(true)}
                    <View class="flex-row flex-wrap gap-2">
                      <Action
                        label={t("security.confirm_disable")}
                        kind="danger"
                        onPress={submit}
                        disabled={
                          !password() || !code().trim() || action.busy()
                        }
                      />
                      {cancel()}
                    </View>
                  </If>
                </>
              )}
            </If>
          </If>
          <If when={copied()}>
            <Hint>{t("security.copied")}</Hint>
          </If>
        </Panel>
      </Section>
    </WorkspacePage>
  );
}
