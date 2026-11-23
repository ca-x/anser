import { t } from "nsh/i18n";
import { effect, resource, Text, View } from "nsh";
import { ApiError, messageFor, type AnserApi } from "../api";
import type { LazycatTarget } from "../contracts";
import { Action, Choice, Hint, Problem } from "./Controls";

export function LazycatDevicePicker(props: {
  api: AnserApi;
  selected?: LazycatTarget;
  useAccountDevice?: boolean;
  onChange: (target?: LazycatTarget) => void;
  onAvailable: (available: boolean) => void;
}) {
  const devices = resource(({ signal }) => props.api.lazycatDevices(signal));
  const busy = () =>
    devices.state() === "pending" || devices.state() === "refreshing";
  const problem = () => {
    const error = devices.error();
    if (!error) return "";
    if (
      error instanceof ApiError &&
      error.code === "lazycat_identity_unavailable"
    )
      return t("devices.identity_unavailable");
    if (error instanceof ApiError && error.code === "channel_unavailable")
      return t("devices.channel_unavailable");
    if (error instanceof ApiError && error.status === 404)
      return t("devices.unsupported");
    if (error instanceof ApiError && (error.status ?? 0) >= 500)
      return t("devices.unavailable");
    return messageFor(error);
  };
  const options = () => {
    const items = devices()?.devices ?? [];
    const names = new Map<string, number>();
    for (const device of items) {
      const name = device.name.trim();
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    return items.map((device) => {
      const name = device.name.trim();
      const duplicate = name && (names.get(name) ?? 0) > 1;
      const label = duplicate
        ? `${name} · ${device.device_id}`
        : name || device.device_id;
      return {
        value: device.device_id,
        label,
        online: device.online,
        title: t(device.online ? "devices.online" : "devices.offline", {
          name: label,
        }),
      };
    });
  };
  const available = () => {
    const list = devices();
    const selected = props.selected;
    return Boolean(
      devices.state() === "ready" &&
        list &&
        selected &&
        selected.user_id === list.user_id &&
        list.devices.some((device) => device.device_id === selected.device_id),
    );
  };
  effect(() => props.onAvailable(available()));

  return (
    <View class="gap-2">
      <Choice
        label={t("devices.destination")}
        placeholder={t("devices.choose")}
        value={
          props.selected
            ? available()
              ? props.selected.device_id
              : null
            : props.useAccountDevice
              ? ""
              : null
        }
        items={[
          ...(props.useAccountDevice
            ? [{ value: "", title: t("devices.use_account") }]
            : []),
          ...(devices.state() === "ready" ? options() : []),
        ]}
        disabled={
          !(props.useAccountDevice && props.selected) &&
          (busy() || Boolean(devices.error()) || !devices()?.devices.length)
        }
        renderLabel={(value, title) => {
          const option = options().find((device) => device.value === value);
          return <View class="flex-1 flex-row items-center gap-2">
            {option && <View class={option.online ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-device-offline"} />}
            <Text class="flex-1 text-sm text-foreground">{option?.label ?? title}</Text>
          </View>;
        }}
        onChange={(id) => {
          const list = devices();
          if (!id) props.onChange(undefined);
          else if (
            devices.state() === "ready" &&
            list?.devices.some((device) => device.device_id === id)
          )
            props.onChange({ user_id: list.user_id, device_id: id });
        }}
      />
      <Problem message={problem()} />
      <If when={devices.state() === "ready" && props.selected && !available()}>
        <Hint>{t("devices.choose_again")}</Hint>
      </If>
      <If when={busy()}>
        <Hint>{t("devices.loading")}</Hint>
      </If>
      <If when={devices.state() === "ready" && !devices()?.devices.length}>
        <Hint>{t("devices.empty")}</Hint>
      </If>
      <If when={!busy()}>
        <Action
          label={t("devices.refresh")}
          kind="quiet"
          class="self-start"
          onPress={devices.refetch}
        />
      </If>
    </View>
  );
}
