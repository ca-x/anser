import { t } from "nsh/i18n";
import { effect, resource, Text, View } from "nsh";
import { Checkbox } from "nsh/base";
import { ApiError, messageFor, type AnserApi } from "../api";
import type { LazycatTarget } from "../contracts";
import { Action, Hint, Problem } from "./Controls";

export function serializeDeviceTarget({ user_id, device_ids }: LazycatTarget) {
  return device_ids.length === 1 ? { user_id, device_id: device_ids[0] } : { user_id, device_ids };
}

export function LazycatDevicePicker(props: {
  api: AnserApi;
  accountId?: string;
  selected?: LazycatTarget;
  useAccountDevice?: boolean;
  onChange: (target?: LazycatTarget) => void;
  onAvailable: (available: boolean) => void;
}) {
  const devices = resource(({ signal }) => props.api.lazycatDevices(signal, props.accountId));
  const busy = () =>
    devices.state() === "pending" || devices.state() === "refreshing";
  const problem = () => {
    const error = devices.error();
    if (!error) return "";
    if (error instanceof ApiError && error.code === "lazycat_identity_unavailable")
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
    for (const { name } of items) names.set(name.trim(), (names.get(name.trim()) ?? 0) + 1);
    return items.map(({ name, online, device_id: id }) => {
      const title = name.trim();
      const label = (names.get(title) ?? 0) > 1 ? `${title} · ${id}` : title || id;
      return { id, label, online };
    });
  };
  const limit = () => devices()?.max_selection ?? 1;
  const visible = () => {
    const list = devices();
    if (!list || !props.selected || props.selected.user_id !== list.user_id) return [];
    return props.selected.device_ids.filter((id) => list.devices.some((item) => item.device_id === id));
  };
  const available = () =>
    devices.state() === "ready" && !!props.selected?.device_ids.length
    && props.selected.device_ids.length <= limit() && visible().length === props.selected.device_ids.length;

  let hydrated = false;
  effect(() => {
    const list = devices();
    if (!hydrated && list && devices.state() === "ready") {
      hydrated = true;
      if (props.accountId && !props.selected && list.configured_device_ids?.length)
        props.onChange({ user_id: list.user_id, device_ids: list.configured_device_ids });
    }
    props.onAvailable(available());
  });

  function select(id: string, checked: boolean) {
    const list = devices();
    if (!list || devices.state() !== "ready") return;
    const active = visible();
    const ids = checked ? [...active, id] : active.filter((item) => item !== id);
    props.onChange(!ids.length && props.useAccountDevice ? undefined : { user_id: list.user_id, device_ids: ids });
  }

  return (
    <View class="gap-2">
      <Text role="header" class="text-sm font-semibold text-foreground">{t("devices.destination")}</Text>
      <Each of={devices.state() === "ready" ? options() : []} key={(item) => item.id}>
        {(option) => {
          const checked = () => visible().includes(option().id);
          return <Checkbox
            checked={checked()}
            disabled={!checked() && visible().length >= limit()}
            onChange={({ checked }) => select(option().id, checked)}
            accessibilityLabel={t(option().online ? "devices.online" : "devices.offline", { name: option().label })}
            class="min-h-12 flex-row items-center gap-2.5 rounded-md border border-input bg-card px-3 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            indicatorClass="size-5 items-center justify-center rounded border border-input checked:border-primary checked:bg-primary"
            indicator={<If when={checked()}><Text class="text-xs text-primary-foreground">✓</Text></If>}
          >
            <View class={option().online ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-device-offline"} />
            <Text class="min-w-0 flex-1 text-sm text-foreground">{option().label}</Text>
          </Checkbox>;
        }}
      </Each>
      <Problem message={problem()} />
      <If when={devices.state() === "ready" && props.selected && props.selected.device_ids.length > 0 && !available()}>
        <Hint>{t("devices.choose_again")}</Hint>
      </If>
      <If when={busy()}><Hint>{t("devices.loading")}</Hint></If>
      <If when={devices.state() === "ready" && !devices()?.devices.length}><Hint>{t("devices.empty")}</Hint></If>
      <If when={devices.state() === "ready" && (devices()?.devices.length ?? 0) > 0}>
        <Hint>{t("devices.chosen", { count: visible().length, limit: limit() })}</Hint>
      </If>
      <If when={props.useAccountDevice}>
        <If when={props.selected} else={<Hint>{t("devices.use_account")}</Hint>}>
          <Action label={t("devices.use_account")} kind="quiet" class="self-start" onPress={() => props.onChange(undefined)} />
        </If>
      </If>
      <If when={!busy()}>
        <Action label={t("devices.refresh")} kind="quiet" class="self-start" onPress={devices.refetch} />
      </If>
    </View>
  );
}
