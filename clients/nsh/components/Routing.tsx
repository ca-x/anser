import { signal, View } from "nsh";
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

const modes = [
  { value: "broadcast", title: "广播到全部匹配账号" },
  { value: "failover", title: "按优先级故障转移" },
  { value: "weighted", title: "加权随机选择" },
  { value: "weighted_failover", title: "加权选择后按序兜底" },
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
        const base = integer(delay(), "初始间隔", 1, 86400000);
        value.retry = {
          max_attempts: integer(attempts(), "每个账号尝试次数", 1, 100),
          backoff: backoff(),
          base_delay: base,
          max_delay: integer(maximum(), "最大间隔", base, 86400000),
          ttl: integer(ttl(), "消息存活时间", 1, 604800000),
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
        label="路由方式"
        value={props.draft.mode() ?? (props.optional ? "inherit" : "broadcast")}
        items={
          props.optional
            ? [{ value: "inherit", title: "沿用服务器策略" }, ...modes]
            : modes
        }
        onChange={(value) =>
          props.draft.mode.set(
            value === "inherit" ? null : (value as Mode | null),
          )
        }
      />
      <If when={props.draft.mode() === "broadcast"}>
        <Choice
          label="广播成功条件"
          value={props.draft.criteria()}
          items={[
            { value: "all", title: "全部成功" },
            { value: "any", title: "任一成功" },
          ]}
          onChange={(value) =>
            props.draft.criteria.set(value === "any" ? "any" : "all")
          }
        />
      </If>
      <Toggle
        label="自定义重试间隔和次数"
        checked={props.draft.configureRetry()}
        onChange={props.draft.configureRetry.set}
      />
      <If when={props.draft.configureRetry()}>
        <View class="gap-3">
          <Choice
            label="退避方式"
            value={props.draft.backoff()}
            items={[
              { value: "exponential", title: "指数退避" },
              { value: "fixed", title: "固定间隔" },
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
                label="每个账号尝试次数"
                keyboard="numeric"
                value={props.draft.attempts()}
                onChange={props.draft.attempts.set}
              />
            </View>
            <View class="flex-1">
              <Field
                label="初始间隔（毫秒）"
                keyboard="numeric"
                value={props.draft.delay()}
                onChange={props.draft.delay.set}
              />
            </View>
          </View>
          <View class="gap-3 md:flex-row">
            <View class="flex-1">
              <Field
                label="最大间隔（毫秒）"
                keyboard="numeric"
                value={props.draft.maximum()}
                onChange={props.draft.maximum.set}
              />
            </View>
            <View class="flex-1">
              <Field
                label="消息存活时间（毫秒）"
                keyboard="numeric"
                value={props.draft.ttl()}
                onChange={props.draft.ttl.set}
              />
            </View>
          </View>
          <Toggle
            label="打散重试时间"
            checked={props.draft.jitter()}
            onChange={props.draft.jitter.set}
          />
          <Toggle
            label="在存活时间内继续尝试"
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
    <Section title={props.title ?? "目标"}>
      <If when={props.targets.length === 0}>
        <Hint>{props.emptyLabel ?? "尚未添加目标。"}</Hint>
      </If>
      <Each of={props.targets} key={(target) => JSON.stringify(target)}>
        {(target, index) => (
          <RecordRow
            title={selectorTitle(
              target(),
              props.accounts.find((item) => item.id === target().account_id)
                ?.name,
              props.channels.find((item) => item.id === target().channel)
                ?.display_name,
            )}
            subtitle={[
              target().weight == null ? "" : `权重 ${target().weight}`,
              target().priority == null ? "" : `优先级 ${target().priority}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            status={
              <View class="flex-row flex-wrap items-center gap-1">
                <If when={props.allowOverrides}>
                  <Action
                    label="上移"
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
                  label="移除"
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
            label="添加目标"
            class="self-start"
            onPress={() => choose.set(true)}
          />
        }
      >
        <Panel>
          <Choice
            label="渠道"
            value={channel()}
            items={[
              { value: "", title: "不限渠道" },
              ...props.channels.map((entry) => ({
                value: entry.id,
                title: entry.display_name,
              })),
            ]}
            onChange={(value) => {
              channel.set(value ?? "");
              account.set("");
            }}
          />
          <Choice
            label="账号"
            value={account()}
            items={[
              { value: "", title: "不限账号" },
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
            label="账号标签"
            value={tagText()}
            onChange={tagText.set}
            hint="多个标签用逗号分隔。"
          />
          <If when={props.allowOverrides}>
            <View class="gap-3 md:flex-row">
              <View class="flex-1">
                <Field
                  label="权重（可选）"
                  keyboard="numeric"
                  value={weight()}
                  onChange={weight.set}
                />
              </View>
              <View class="flex-1">
                <Field
                  label="优先级（可选）"
                  keyboard="numeric"
                  value={priority()}
                  onChange={priority.set}
                />
              </View>
            </View>
          </If>
          <View class="flex-row flex-wrap gap-2">
            <Action
              label="添加"
              kind="primary"
              disabled={!valid()}
              onPress={add}
            />
            <Action
              label="取消"
              onPress={() => choose.set(false)}
              kind="quiet"
            />
          </View>
        </Panel>
      </If>
    </Section>
  );
}
