import { t } from "nsh/i18n";
import { locale, Text } from "nsh";

const statuses: Record<
  string,
  { label: string; style: string; live?: boolean }
> = {
  pending: {
    label: "delivery_status.queued",
    style: "text-warning",
    live: true,
  },
  waiting: {
    label: "delivery_status.waiting",
    style: "text-warning",
    live: true,
  },
  sending: {
    label: "delivery_status.sending",
    style: "text-warning",
    live: true,
  },
  success: { label: "delivery_status.succeeded", style: "text-success" },
  failed: { label: "delivery_status.failed", style: "text-destructive" },
  dead: { label: "delivery_status.dead_letter", style: "text-destructive" },
  cancelled: {
    label: "delivery_status.canceled",
    style: "text-muted-foreground",
  },
  skipped: { label: "delivery_status.skipped", style: "text-muted-foreground" },
};

export function activeStatus(value: string) {
  return statuses[value]?.live === true;
}

export function DeliveryStatus(props: { value: string }) {
  const status = () =>
    statuses[props.value] ?? {
      label: props.value,
      style: "text-muted-foreground",
    };
  return (
    <Text class={`text-sm font-semibold ${status().style}`}>
      {statuses[props.value] ? t(status().label) : status().label}
    </Text>
  );
}

export function localTime(value?: number | null) {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(locale(), {
        dateStyle: "medium",
        timeStyle: "medium",
      })
    : "—";
}
