import { useChannelName, useT } from "../preferences";
import { useId, useState } from "react";
import {
  EuiAccordion, EuiButtonEmpty, EuiFieldNumber, EuiFieldText, EuiFormRow, EuiSelect, EuiSwitch, EuiText,
} from "@elastic/eui";
import type { Account, Channel, Policy, Retry, Target } from "../api";
import { split } from "./Common";

export const baselinePolicy: Policy = {
  mode: "broadcast", targets: [], success_criteria: "all",
  retry: { max_attempts: 3, backoff: "exponential", base_delay: 1000, max_delay: 30000, jitter: true, until_success: false, ttl: 3600000 },
};

export const modes = [
  { value: "broadcast", text: "广播" }, { value: "failover", text: "按优先级故障转移" },
  { value: "weighted", text: "按权重分流" }, { value: "weighted_failover", text: "加权故障转移" },
];

function options(current: string | undefined, empty: string, choices: { value: string; text: string }[]) {
  // A selected account may be beyond the loaded page, or its plugin temporarily absent.
  if (current && !choices.some(({ value }) => value === current)) choices.unshift({ value: current, text: current });
  return [{ value: "", text: empty }, ...choices];
}

export function PolicyFields({ value, update, channels, accounts }: {
  value: Policy; update: (value: Policy) => void; channels: Channel[]; accounts: Account[];
}) {
  const channelName = useChannelName();
  const t = useT();
  const advanced = useId();
  function updateTarget(index: number, target?: Target) {
    update({ ...value, targets: target ? value.targets.map((entry, position) => position === index ? target : entry)
      : value.targets.filter((_, position) => position !== index) });
  }
  return <section className="stack">
    <div className="form-grid">
      <EuiFormRow label={t("路由模式")} fullWidth>
        <EuiSelect fullWidth options={modes.map((mode) => ({...mode, text: t(mode.text)}))} value={value.mode} onChange={(event) => update({ ...value, mode: event.target.value as Policy["mode"] })} />
      </EuiFormRow>
      {value.mode === "broadcast" && <EuiFormRow label={t("成功判定")} fullWidth>
        <EuiSelect fullWidth value={value.success_criteria} options={[{ value: "all", text: t("全部送达") }, { value: "any", text: t("任一送达") }]}
          onChange={(event) => update({ ...value, success_criteria: event.target.value as Policy["success_criteria"] })} />
      </EuiFormRow>}
    </div>
    <div className="section-header"><h3>{t("路由目标")}</h3><EuiButtonEmpty size="s" iconType="plus" onClick={() => update({ ...value, targets: [...value.targets, {}] })}>{t("添加目标")}</EuiButtonEmpty></div>
    {value.targets.length === 0 && <EuiText size="s" color="subdued"><p>{t("无显式目标时使用所有启用账号。")}</p></EuiText>}
    {value.targets.map((target, index) => <fieldset className="target-row" key={index}>
      <legend>{t("目标 {number}", { number: index + 1 })}</legend>
      <div className="form-grid">
        <EuiFormRow label={t("渠道")} fullWidth><EuiSelect fullWidth
          value={target.channel ?? ""}
          options={options(target.channel, t("不限渠道"), channels.filter((channel) => channel.direction !== "ingress" && channel.egress_enabled !== false).map(({ id, display_name }) => ({ value: id, text: channelName(id, display_name) })))}
          onChange={(event) => updateTarget(index, { ...target, channel: event.target.value || undefined, account_id: undefined })} />
        </EuiFormRow>
        <EuiFormRow label={t("账号")} fullWidth><EuiSelect fullWidth value={target.account_id ?? ""}
          options={options(target.account_id, t("不限账号"), accounts.filter(({ channel }) => !target.channel || channel === target.channel).map(({ id, name }) => ({ value: id, text: name })))}
          onChange={(event) => updateTarget(index, { ...target, account_id: event.target.value || undefined })} />
        </EuiFormRow>
      </div>
      <TargetTags value={target.tag_selector ?? []} update={(tag_selector) => updateTarget(index, { ...target, tag_selector })} />
      <div className="form-grid">
        <EuiFormRow label={t("覆盖权重")} fullWidth><EuiFieldNumber fullWidth min={0} value={target.weight ?? ""} placeholder={t("跟随账号")}
          onChange={(event) => updateTarget(index, { ...target, weight: event.target.value === "" ? undefined : event.target.valueAsNumber })} /></EuiFormRow>
        <EuiFormRow label={t("覆盖优先级")} fullWidth><EuiFieldNumber fullWidth value={target.priority ?? ""} placeholder={t("跟随账号")}
          onChange={(event) => updateTarget(index, { ...target, priority: event.target.value === "" ? undefined : event.target.valueAsNumber })} /></EuiFormRow>
      </div>
      <EuiButtonEmpty size="xs" color="danger" onClick={() => updateTarget(index)}>{t("移除目标")}</EuiButtonEmpty>
    </fieldset>)}
    <EuiAccordion id={advanced} buttonContent={t("重试和过期")}>
      <RetryFields value={value.retry} update={(retry) => update({ ...value, retry })} />
    </EuiAccordion>
  </section>;
}

function TargetTags({ value, update }: { value: string[]; update: (tags: string[]) => void }) {
  const t = useT();
  const [raw, setRaw] = useState(value.join(", "));
  const text = split(raw).join(", ") === value.join(", ") ? raw : value.join(", ");
  return <EuiFormRow label={t("标签筛选")} helpText={t("账号须同时具备所列标签。")} fullWidth>
    <EuiFieldText value={text} fullWidth onChange={(event) => {
      setRaw(event.target.value);
      update(split(event.target.value));
    }} />
  </EuiFormRow>;
}

function RetryFields({ value, update }: { value: Retry; update: (value: Retry) => void }) {
  const t = useT();
  const numbers = [
    ["max_attempts", t("单账号最大尝试次数"), 1, 100], ["base_delay", t("初始延迟（毫秒）"), 1],
    ["max_delay", t("最大延迟（毫秒）"), 1], ["ttl", t("投递有效期（毫秒）"), 1],
  ] as const;
  return <div className="stack inset">
    <div className="form-grid">{numbers.map(([key, name, min, max]) => <EuiFormRow key={key} label={name} fullWidth>
      <EuiFieldNumber fullWidth required min={min} max={max} value={value[key]} onChange={(event) => update({ ...value, [key]: Number(event.target.value) })} />
    </EuiFormRow>)}</div>
    <EuiFormRow label={t("退避方式")} fullWidth>
      <EuiSelect fullWidth value={value.backoff} onChange={(event) => update({ ...value, backoff: event.target.value as Retry["backoff"] })}
        options={[{ value: "fixed", text: t("固定延迟") }, { value: "exponential", text: t("指数退避") }]} />
    </EuiFormRow>
    <EuiSwitch label={t("延迟随机抖动")} checked={value.jitter} onChange={(event) => update({ ...value, jitter: event.target.checked })} />
    <EuiSwitch label={t("在有效期内重试直到成功")} checked={value.until_success} onChange={(event) => update({ ...value, until_success: event.target.checked })} />
  </div>;
}
