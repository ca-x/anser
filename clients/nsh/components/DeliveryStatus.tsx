import { Text } from "nsh";

const statuses: Record<
  string,
  { label: string; style: string; live?: boolean }
> = {
  pending: { label: "待投递", style: "text-waiting", live: true },
  sending: { label: "投递中", style: "text-waiting", live: true },
  success: { label: "已成功", style: "text-success" },
  failed: { label: "失败", style: "text-destructive" },
  dead: { label: "死信", style: "text-destructive" },
  cancelled: { label: "已取消", style: "text-muted-foreground" },
  skipped: { label: "已跳过", style: "text-muted-foreground" },
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
      {status().label}
    </Text>
  );
}

export function localTime(value?: number | null) {
  if (value == null) return "—";
  const date = new Date(value);
  const two = (number: number) => String(number).padStart(2, "0");
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
