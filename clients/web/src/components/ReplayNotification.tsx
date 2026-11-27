import { useId, useState } from "react";
import { EuiButton, EuiCheckbox, EuiConfirmModal, EuiText } from "@elastic/eui";
import { Api, segment, type Delivery, type MessageDetail, type Receipt } from "../api";
import { useChannelName, useLanguage, useT } from "../preferences";
import { useMutation, useResource } from "../resources";
import { Failure, Progress, RowAction } from "./Common";

const replayable = ["success", "failed", "dead"];
const finished = [...replayable, "cancelled"];

function canReplay(item: MessageDetail) {
  return !item.history_deleted && replayable.includes(item.status) &&
    !item.deliveries?.some((delivery) => !finished.includes(delivery.status));
}

type Props = { api: Api; item: MessageDetail; navigate: (path: string) => void; compact?: boolean };

export function ReplayNotification({ api, item, navigate, compact }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!canReplay(item) || (item.status === "success" && item.inbox_recipient && !item.deliveries?.length)) return null;
  if (!compact && item.status === "success" && !item.deliveries?.some((d) => replayable.includes(d.status))) return null;
  return <>
    {compact ? <RowAction icon="refresh" onClick={() => setOpen(true)}>{t("重放通知")}</RowAction>
      : <EuiButton fill iconType="refresh" onClick={() => setOpen(true)}>{t("重放通知")}</EuiButton>}
    {open && <ReplayDialog api={api} id={item.id} navigate={navigate} close={() => setOpen(false)} />}
  </>;
}

function ReplayDialog({ api, id, navigate, close }: Omit<Props, "item" | "compact"> & { id: string; close: () => void }) {
  const t = useT();
  const channelName = useChannelName();
  const language = useLanguage();
  const inputId = useId();
  const detail = useResource<MessageDetail>(api, `/messages/${segment(id)}`);
  const task = useMutation();
  const [choice, setChoice] = useState<string[]>();
  const item = detail.data;
  const deliveries = item?.deliveries ?? [];
  const available = !!item && !detail.error && canReplay(item);
  const success = deliveries.filter((delivery) => delivery.status === "success");
  const failed = deliveries.filter((delivery) => delivery.status === "failed" || delivery.status === "dead");
  const mixed = !!success.length && !!failed.length;
  const selected = choice ?? (failed.length ? failed : success).map((delivery) => delivery.id);
  const selectedChannels = [...new Set(deliveries.filter((delivery) => selected.includes(delivery.id)).map((delivery) => channelName(delivery.channel)))];
  const channels = new Intl.ListFormat(language, { type: "conjunction" }).format(selectedChannels);
  const currentRoute = available && !deliveries.length && !item.inbox_deliveries && ["failed", "dead"].includes(item.status);
  const allowed = available && (currentRoute || selected.length > 0);
  const title = channels && !mixed ? t("重放发往{channels}的通知？", { channels }) : t("重放通知");
  const groups = (entries: Delivery[], label: string) => entries.length > 0 && <fieldset className="stack">
    <legend><strong>{label}</strong></legend>
    {entries.map((delivery) => {
      const target = [channelName(delivery.channel), delivery.account_name || delivery.account_id, delivery.subscription_id && t("订阅 {id}", { id: delivery.subscription_id })].filter(Boolean).join(" · ");
      return mixed ? <EuiCheckbox key={delivery.id} id={`${inputId}-${delivery.id}`} checked={selected.includes(delivery.id)}
        disabled={task.busy} label={target} onChange={(event) => setChoice(event.target.checked
          ? [...selected, delivery.id] : selected.filter((id) => id !== delivery.id))} />
        : <div key={delivery.id}>{target}</div>;
    })}
  </fieldset>;
  return <EuiConfirmModal title={title} onCancel={() => { if (!task.busy) close(); }} cancelButtonText={t("取消")}
    confirmButtonDisabled={!allowed || task.busy} isLoading={task.busy} defaultFocusedButton="cancel"
    confirmButtonText={t("确认重放")} buttonColor="primary" onConfirm={() => {
      if (!allowed) return;
      void task.run(async () => {
        const result = await api.write<Receipt>(`/messages/${segment(id)}/replay`, "POST", currentRoute ? undefined : { delivery_ids: selected });
        close();
        navigate(`/admin/messages/${segment(result.message_id)}`);
      });
    }}>
    <div className="stack">
      {detail.loading && <Progress />}
      <Failure message={detail.error ?? task.error} retry={detail.error ? detail.reload : undefined} />
      {item && !detail.error && <EuiText size="s"><p>{!available ? t("该记录当前无法重放。")
        : currentRoute ? t("这条通知没有可复用的渠道记录。确认后将按当前路由重新发送。")
        : !failed.length && !success.length ? t("没有可重放的渠道投递。")
        : mixed ? t("已默认选中失败的投递。勾选已送达的目标会再次通知对方。")
        : success.length ? t("下列目标已收到通知。确认后将再次发送。") : t("确认后将重新发送到下列目标。")}</p></EuiText>}
      {available && <>{groups(failed, t("投递失败"))}{groups(success, t("已送达"))}</>}
    </div>
  </EuiConfirmModal>;
}
