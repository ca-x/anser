import { t } from "nsh/i18n";
import { signal, View } from "nsh";
import { channelName } from "../channelNames";
import type {
  Account,
  Channel,
  Criteria,
  Mode,
  Retry,
  Strategy,
  Target,
} from "../contracts";
import { integer, selectorTitle, tagsFrom } from "../forms";
import {
  Action,
  Choice,
  Field,
  Hint,
  Panel,
  Section,
  Toggle,
} from "./Controls";
import { RecordRow } from "./Workspace";

const modes = () => [
  {
    value: "broadcast",
    title: t("routing.broadcast_to_all_matching_accounts"),
  },
  { value: "failover", title: t("routing.fail_over_by_priority") },
  { value: "weighted", title: t("routing.choose_at_random_by_weight") },
  {
    value: "weighted_failover",
    title: t("routing.choose_by_weight_then_fail_over"),
  },
];
const defaults: Required<Retry> = {
  max_attempts: 3,
  backoff: "exponential",
  base_delay: 1000,
  max_delay: 30000,
  ttl: 3600000,
  jitter: true,
  until_success: false,
};

export function strategyDraft(initial?: Strategy) {
  const mode = signal<Mode | null>(initial?.mode ?? null);
  const criteria = signal<Criteria>(initial?.success_criteria ?? "all");
  const retry = { ...defaults, ...initial?.retry };
  const configureRetry = signal(Boolean(initial?.retry));
  const attempts = signal(String(retry.max_attempts));
  const backoff = signal<Required<Retry>["backoff"]>(retry.backoff);
  const delay = signal(String(retry.base_delay));
  const maximum = signal(String(retry.max_delay));
  const ttl = signal(String(retry.ttl));
  const jitter = signal(retry.jitter);
  const untilSuccess = signal(retry.until_success);
  return {
    mode,
    criteria,
    configureRetry,
    attempts,
    backoff,
    delay,
    maximum,
    ttl,
    jitter,
    untilSuccess,
    value(): Strategy {
      const selectedMode = mode();
      const value: Strategy = {};
      if (selectedMode) value.mode = selectedMode;
      if (selectedMode === "broadcast") value.success_criteria = criteria();
      if (configureRetry()) {
        const base = integer(delay(), t("routing.initial_delay"), 1, 86400000);
        value.retry = {
          max_attempts: integer(
            attempts(),
            t("routing.attempts_per_account"),
            1,
            100,
          ),
          backoff: backoff(),
          base_delay: base,
          max_delay: integer(
            maximum(),
            t("routing.maximum_delay"),
            base,
            86400000,
          ),
          ttl: integer(ttl(), t("routing.message_lifetime"), 1, 604800000),
          jitter: jitter(),
          until_success: untilSuccess(),
        };
      }
      return value;
    },
  };
}

export function StrategyEditor(props: {
  draft: ReturnType<typeof strategyDraft>;
  optional?: boolean;
}) {
  return (
    <View class="gap-3">
      <Choice
        label={t("routing.routing_mode")}
        value={props.draft.mode() ?? (props.optional ? "inherit" : "broadcast")}
        items={
          props.optional
            ? [
                { value: "inherit", title: t("routing.use_server_policy") },
                ...modes(),
              ]
            : modes()
        }
        onChange={(value) =>
          props.draft.mode.set(
            value === "inherit" ? null : (value as Mode | null),
          )
        }
      />
      <If when={props.draft.mode() === "broadcast"}>
        <Choice
          label={t("routing.broadcast_success_criteria")}
          value={props.draft.criteria()}
          items={[
            { value: "all", title: t("routing.all_succeed") },
            { value: "any", title: t("routing.any_succeeds") },
          ]}
          onChange={(value) =>
            props.draft.criteria.set(value === "any" ? "any" : "all")
          }
        />
      </If>
      <Toggle
        label={t("routing.customize_retry_timing_and_attempts")}
        checked={props.draft.configureRetry()}
        onChange={props.draft.configureRetry.set}
      />
      <If when={props.draft.configureRetry()}>
        <View class="gap-3">
          <Choice
            label={t("routing.backoff")}
            value={props.draft.backoff()}
            items={[
              { value: "exponential", title: t("routing.exponential_backoff") },
              { value: "fixed", title: t("routing.fixed_delay") },
            ]}
            onChange={(value) =>
              props.draft.backoff.set(
                value === "fixed" ? "fixed" : "exponential",
              )
            }
          />
          <View class="gap-3 md:flex-row">
            <View class="flex-1">
              <Field
                label={t("routing.attempts_per_account")}
                keyboard="numeric"
                value={props.draft.attempts()}
                onChange={props.draft.attempts.set}
              />
            </View>
            <View class="flex-1">
              <Field
                label={t("routing.initial_delay_ms")}
                keyboard="numeric"
                value={props.draft.delay()}
                onChange={props.draft.delay.set}
              />
            </View>
          </View>
          <View class="gap-3 md:flex-row">
            <View class="flex-1">
              <Field
                label={t("routing.maximum_delay_ms")}
                keyboard="numeric"
                value={props.draft.maximum()}
                onChange={props.draft.maximum.set}
              />
            </View>
            <View class="flex-1">
              <Field
                label={t("routing.message_lifetime_ms")}
                keyboard="numeric"
                value={props.draft.ttl()}
                onChange={props.draft.ttl.set}
              />
            </View>
          </View>
          <Toggle
            label={t("routing.randomize_retry_intervals")}
            checked={props.draft.jitter()}
            onChange={props.draft.jitter.set}
          />
          <Toggle
            label={t("routing.keep_trying_within_the_message_lifetime")}
            checked={props.draft.untilSuccess()}
            onChange={props.draft.untilSuccess.set}
          />
        </View>
      </If>
    </View>
  );
}

export function Targets(props: {
  targets: Target[];
  onChange: (targets: Target[]) => void;
  accounts: Account[];
  channels: Channel[];
  title?: string;
  emptyLabel?: string;
  allowOverrides?: boolean;
}) {
  const channel = signal("");
  const account = signal("");
  const tagText = signal("");
  const choose = signal(false);
  const weight = signal("");
  const priority = signal("");
  const weightValue = () => Number(weight());
  const priorityValue = () => Number(priority());
  const valid = () =>
    (Boolean(channel() || account()) || tagsFrom(tagText()).length > 0) &&
    (!weight() ||
      (Number.isInteger(weightValue()) &&
        weightValue() >= 0 &&
        weightValue() <= 4294967295)) &&
    (!priority() ||
      (Number.isInteger(priorityValue()) &&
        priorityValue() >= -2147483648 &&
        priorityValue() <= 2147483647));

  function add() {
    if (!valid()) return;
    const target: Target = {};
    if (channel()) target.channel = channel();
    if (account()) target.account_id = account();
    const tags = tagsFrom(tagText());
    if (tags.length) target.tag_selector = tags;
    if (props.allowOverrides && weight()) target.weight = weightValue();
    if (props.allowOverrides && priority()) target.priority = priorityValue();
    if (
      !props.targets.some(
        (existing) => JSON.stringify(existing) === JSON.stringify(target),
      )
    ) {
      props.onChange([...props.targets, target]);
    }
    channel.set("");
    account.set("");
    tagText.set("");
    weight.set("");
    priority.set("");
    choose.set(false);
  }

  return (
    <Section title={props.title ?? t("routing.targets")}>
      <If when={props.targets.length === 0}>
        <Hint>{props.emptyLabel ?? t("routing.no_targets_added")}</Hint>
      </If>
      <Each of={props.targets} key={(target) => JSON.stringify(target)}>
        {(target, index) => (
          <RecordRow
            title={selectorTitle(
              target(),
              props.accounts.find((item) => item.id === target().account_id)
                ?.name,
              target().channel
                ? channelName(
                    target().channel!,
                    props.channels.find((item) => item.id === target().channel)
                      ?.display_name,
                  )
                : undefined,
            )}
            subtitle={[
              target().weight == null
                ? ""
                : t("routing.target_weight", { weight: target().weight }),
              target().priority == null
                ? ""
                : t("routing.target_priority", { priority: target().priority }),
            ]
              .filter(Boolean)
              .join(" · ")}
            status={
              <View class="flex-row flex-wrap items-center gap-1">
                <If when={props.allowOverrides}>
                  <Action
                    label={t("routing.move_up")}
                    kind="quiet"
                    disabled={index() === 0}
                    onPress={() => {
                      const targets = [...props.targets];
                      const i = index();
                      if (i > 0) {
                        [targets[i - 1], targets[i]] = [
                          targets[i],
                          targets[i - 1],
                        ];
                        props.onChange(targets);
                      }
                    }}
                  />
                </If>
                <Action
                  label={t("routing.remove")}
                  kind="quiet"
                  onPress={() =>
                    props.onChange(
                      props.targets.filter(
                        (_, itemIndex) => itemIndex !== index(),
                      ),
                    )
                  }
                />
              </View>
            }
          />
        )}
      </Each>
      <If
        when={choose()}
        else={
          <Action
            label={t("routing.add_target")}
            class="self-start"
            onPress={() => choose.set(true)}
          />
        }
      >
        <Panel>
          <Choice
            label={t("common.channel")}
            value={channel()}
            items={[
              { value: "", title: t("routing.any_channel") },
              ...props.channels.map((entry) => ({
                value: entry.id,
                title: channelName(entry.id, entry.display_name),
              })),
            ]}
            onChange={(value) => {
              channel.set(value ?? "");
              account.set("");
            }}
          />
          <Choice
            label={t("common.account")}
            value={account()}
            items={[
              { value: "", title: t("routing.any_account") },
              ...props.accounts
                .filter((item) => !channel() || item.channel === channel())
                .map((item) => ({
                  value: item.id,
                  title: item.name,
                  disabled: !item.enabled,
                })),
            ]}
            onChange={(value) => account.set(value ?? "")}
          />
          <Field
            label={t("routing.account_tags")}
            value={tagText()}
            onChange={tagText.set}
            hint={t("common.separate_multiple_tags_with_commas")}
          />
          <If when={props.allowOverrides}>
            <View class="gap-3 md:flex-row">
              <View class="flex-1">
                <Field
                  label={t("routing.weight_optional")}
                  keyboard="numeric"
                  value={weight()}
                  onChange={weight.set}
                />
              </View>
              <View class="flex-1">
                <Field
                  label={t("routing.priority_optional")}
                  keyboard="numeric"
                  value={priority()}
                  onChange={priority.set}
                />
              </View>
            </View>
          </If>
          <View class="flex-row flex-wrap gap-2">
            <Action
              label={t("routing.add")}
              kind="primary"
              disabled={!valid()}
              onPress={add}
            />
            <Action
              label={t("common.cancel")}
              onPress={() => choose.set(false)}
              kind="quiet"
            />
          </View>
        </Panel>
      </If>
    </Section>
  );
}
