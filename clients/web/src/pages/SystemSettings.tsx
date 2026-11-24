import { useState } from "react";
import { EuiButton, EuiFieldNumber, EuiFormRow, EuiSwitch } from "@elastic/eui";
import type { Api } from "../api";
import { Failure, PageTitle, Progress } from "../components/Common";
import { useT } from "../preferences";
import { useMutation, useResource } from "../resources";

type HistoryRetention = { enabled: boolean; days: number };
const historyPath = "/settings/history-retention";

export default function SystemSettings({ api }: { api: Api }) {
  const t = useT();
  const settings = useResource<HistoryRetention>(api, historyPath);
  return <>
    <PageTitle title={t("系统设置")} />
    <Failure message={settings.error} retry={settings.reload} />
    {settings.loading && <Progress />}
    {settings.data && <RetentionForm api={api} initial={settings.data} />}
  </>;
}

function RetentionForm({ api, initial }: { api: Api; initial: HistoryRetention }) {
  const t = useT();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [days, setDays] = useState(String(initial.days));
  const [confirmed, setConfirmed] = useState(false);
  const task = useMutation();
  const changed = enabled !== saved.enabled || Number(days) !== saved.days;

  return <form className="channel-settings stack" aria-label={t("投递记录保留")} onSubmit={(event) => {
    event.preventDefault();
    void task.run(async () => {
      const result = await api.write<HistoryRetention>(historyPath, "PUT", { enabled, days: Number(days) });
      setSaved(result);
      setConfirmed(true);
    });
  }}>
    <h2>{t("投递记录保留")}</h2>
    <EuiSwitch label={t("自动清理投递记录")} checked={enabled} disabled={task.busy} onChange={(event) => {
      setEnabled(event.target.checked); setConfirmed(false);
    }} />
    <EuiFormRow label={t("投递记录保留天数")} helpText={t("开启后，自动清理超过保留期的记录。已单独设置保留天数的主题按各自设置清理。")} fullWidth>
      <EuiFieldNumber fullWidth required min={1} max={3650} step={1} disabled={task.busy} value={days} onChange={(event) => {
        setDays(event.target.value); setConfirmed(false);
      }} />
    </EuiFormRow>
    <Failure message={task.error} />
    <div className="row-actions">
      <EuiButton type="submit" fill isLoading={task.busy} disabled={!changed}>{t("保存设置")}</EuiButton>
      {confirmed && <span className="muted" role="status">{t("设置已保存。")}</span>}
    </div>
  </form>;
}
