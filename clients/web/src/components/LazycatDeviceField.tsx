import { EuiButtonEmpty, EuiFormRow, EuiScreenReaderOnly, EuiSuperSelect } from "@elastic/eui";
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
      <EuiSuperSelect fullWidth isInvalid={stale} disabled={loading || (!devices.length && !target)}
        placeholder={t("选择设备")} popoverProps={{ repositionOnScroll: true }}
        valueOfSelected={target ? current ? `device:${current.device_id}` : "unlisted" : optionalLabel ? "" : undefined} options={[
          ...(optionalLabel ? [{ value: "", inputDisplay: optionalLabel }] : []),
          ...(target && !current ? [{ value: "unlisted", inputDisplay: t("之前选择的设备"), disabled: true }] : []),
          ...devices.map(({ device_id, name, online }) => {
            const status = t(online ? "设备在线" : "设备离线");
            return {
              value: `device:${device_id}`,
              inputDisplay: <span className="device-option">
                <span className="device-status-dot" data-online={online} aria-hidden="true" title={status} />
                <span className="device-option-name">{(counts.get(name) ?? 0) > 1 ? `${name} · ${device_id}` : name || device_id}</span>
                <EuiScreenReaderOnly><span>{status}</span></EuiScreenReaderOnly>
              </span>,
            };
          }),
        ]} onChange={(selection) => {
          if (!selection) choose(undefined);
          else if (directory && selection.startsWith("device:")) {
            choose({ user_id: directory.user_id, device_id: selection.slice("device:".length) });
          }
        }} />
    </EuiFormRow>
    <Failure message={error} />
    <div><EuiButtonEmpty size="s" flush="left" iconType="refresh" isLoading={loading} onClick={refresh}>{t("刷新设备")}</EuiButtonEmpty></div>
  </div>;
}
