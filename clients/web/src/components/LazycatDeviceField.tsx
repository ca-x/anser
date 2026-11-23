import { useId } from "react";
import { EuiButtonEmpty, EuiCheckbox, EuiScreenReaderOnly } from "@elastic/eui";
import { Api, type LazycatDevices } from "../api";
import { useResource } from "../resources";
import { currentDevices, type DeviceTarget } from "../form-values";
import { useT } from "../preferences";
import { Failure } from "./Common";

export function useDeviceDirectory(api: Api, enabled: boolean, accountId?: string) {
  const path = accountId ? `/channels/lazycat/devices?account_id=${encodeURIComponent(accountId)}` : "/channels/lazycat/devices";
  const result = useResource<LazycatDevices>(api, enabled ? path : undefined);
  const loading = result.loading || !!result.fetching;
  return {
    data: enabled ? result.data : undefined,
    error: result.error,
    loading,
    refresh: result.reload,
    accepts: (target: DeviceTarget | undefined) => enabled && !loading && !result.error && currentDevices(result.data, target),
  };
}

export function LazycatDeviceField({ state, target, optionalLabel, inherited, choose }: {
  state: ReturnType<typeof useDeviceDirectory>; target?: DeviceTarget; optionalLabel?: string; inherited?: boolean;
  choose: (target: DeviceTarget | undefined) => void;
}) {
  const t = useT();
  const id = useId();
  const { data: directory, loading, error, refresh } = state;
  const devices = directory?.devices ?? [];
  const limit = directory?.max_selection ?? 1;
  const selected = target ? target.user_id === directory?.user_id ? target.device_ids : [] : directory?.configured_device_ids ?? [];
  const visible = selected.filter((id) => devices.some((device) => device.device_id === id));
  const stale = !!directory && !loading && !error && (selected.length !== visible.length || (target && target.user_id !== directory.user_id));
  const counts = new Map<string, number>();
  for (const { name } of devices) counts.set(name, (counts.get(name) ?? 0) + 1);

  return <fieldset className="device-field">
    <legend>{t("接收设备")}</legend>
    {loading && <p className="muted" role="status">{t("正在读取设备…")}</p>}
    {!loading && !error && directory && !devices.length && <p className="muted">{t("未找到设备。请在设备上登录懒猫微服，然后刷新。")}</p>}
    {stale && <Failure message="所选设备有变更，请重新勾选。" />}
    <Failure message={error} />
    {!!devices.length && <div className="device-checklist" aria-describedby={id}>
      {devices.map(({ device_id, name, online }, index) => {
        const status = t(online ? "设备在线" : "设备离线");
        const checked = visible.includes(device_id);
        return <EuiCheckbox className="device-checkbox" key={device_id} id={`${id}-${index}`}
          disabled={loading || !!error || (!checked && visible.length >= limit)}
          checked={checked}
          label={<span className="device-option">
            <span className="device-status-dot" data-online={online} aria-hidden="true" title={status} />
            <span className="device-option-name">{(counts.get(name) ?? 0) > 1 ? `${name} · ${device_id}` : name || device_id}</span>
            <EuiScreenReaderOnly><span>{status}</span></EuiScreenReaderOnly>
          </span>}
          onChange={(event) => {
            if (!directory) return;
            const device_ids = event.target.checked ? [...visible, device_id] : visible.filter((id) => id !== device_id);
            choose(!device_ids.length && inherited ? undefined : { user_id: directory.user_id, device_ids });
          }} />;
      })}
    </div>}
    {directory && <p id={id} className="muted" role="status">
      {limit > 1 ? t("已选 {count} 台 · 最多 {limit} 台", { count: visible.length, limit }) : t("当前服务器支持选择一台设备。")}
      {inherited && !target && optionalLabel ? ` · ${optionalLabel}` : ""}
    </p>}
    <div className="row-actions">
      <EuiButtonEmpty size="s" flush="left" iconType="refresh" isLoading={loading} onClick={refresh}>{t("刷新设备")}</EuiButtonEmpty>
      {target && optionalLabel && <EuiButtonEmpty size="s" onClick={() => choose(undefined)}>{optionalLabel}</EuiButtonEmpty>}
    </div>
  </fieldset>;
}
