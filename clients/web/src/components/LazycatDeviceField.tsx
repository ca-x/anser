import { EuiButtonEmpty, EuiFormRow, EuiSelect } from "@elastic/eui";
import { Api, type LazycatDevices } from "../api";
import { useResource } from "../resources";
import { currentDevice, type DeviceTarget } from "../form-values";
import { useT } from "../preferences";
import { Failure } from "./Common";

export function useDeviceDirectory(api: Api, enabled: boolean) {
  const result = useResource<LazycatDevices>(api, enabled ? "/channels/lazycat/devices" : undefined);
  const loading = result.loading || !!result.fetching;
  return {
    data: enabled ? result.data : undefined,
    error: result.error,
    loading,
    refresh: result.reload,
    accepts: (target: DeviceTarget | undefined) => enabled && !loading && !result.error && !!currentDevice(result.data, target),
  };
}

export function LazycatDeviceField({ state, target, optionalLabel, choose }: {
  state: ReturnType<typeof useDeviceDirectory>; target?: DeviceTarget; optionalLabel?: string;
  choose: (target: DeviceTarget | undefined) => void;
}) {
  const t = useT();
  const { data: directory, loading, error, refresh } = state;
  const devices = directory?.devices ?? [];
  const current = currentDevice(directory, target);
  const stale = !!target && !current && !loading && !error;
  const counts = new Map<string, number>();
  for (const { name } of devices) counts.set(name, (counts.get(name) ?? 0) + 1);
  const help = loading ? t("正在读取设备…") : directory && !devices.length && !error
    ? t("未找到设备。请在设备上登录懒猫微服，然后刷新。") : undefined;
  return <div className="stack">
    <EuiFormRow label={t("接收设备")} fullWidth helpText={help} isInvalid={stale}
      error={stale ? t("所选设备已不在当前设备列表中，请重新选择。") : undefined}>
      <EuiSelect fullWidth required={!optionalLabel} isInvalid={stale} disabled={loading || (!devices.length && !target)}
        value={target ? current ? `device:${current.device_id}` : "unlisted" : ""} options={[
          { value: "", text: optionalLabel ?? t("选择设备") },
          ...(target && !current ? [{ value: "unlisted", text: t("之前选择的设备"), disabled: true }] : []),
          ...devices.map(({ device_id, name, online }) => ({
            value: `device:${device_id}`, text: t(online ? "{name}（在线）" : "{name}（离线）", {
              name: (counts.get(name) ?? 0) > 1 ? `${name} · ${device_id}` : name || device_id,
            }),
          })),
        ]} onChange={(event) => {
          const selection = event.target.value;
          choose(selection && directory ? { user_id: directory.user_id, device_id: selection.slice("device:".length) } : undefined);
        }} />
    </EuiFormRow>
    <Failure message={error} />
    <div><EuiButtonEmpty size="s" flush="left" iconType="refresh" isLoading={loading} onClick={refresh}>{t("刷新设备")}</EuiButtonEmpty></div>
  </div>;
}
