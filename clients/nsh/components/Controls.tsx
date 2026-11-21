import { t } from "nsh/i18n";
import { Text, View, type JSX } from "nsh";
import { AlertDialog, Button, Input, Select, Switch } from "nsh/base";

type ButtonKind = "primary" | "secondary" | "quiet" | "danger";

const buttonSurfaces: Record<ButtonKind, string> = {
  primary: "bg-primary active:opacity-80",
  secondary: "border border-input bg-card hover:bg-muted active:bg-accent",
  quiet: "hover:bg-muted active:bg-accent",
  danger: "border border-destructive hover:bg-muted active:bg-accent",
};
const buttonText: Record<ButtonKind, string> = {
  primary: "text-primary-foreground",
  secondary: "text-foreground",
  quiet: "text-foreground",
  danger: "text-destructive",
};

export function Action(props: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      class={`min-h-11 items-center justify-center rounded-md px-3 py-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${buttonSurfaces[props.kind ?? "secondary"]} ${props.class ?? ""}`}
    >
      <Text
        class={`text-sm font-semibold ${buttonText[props.kind ?? "secondary"]}`}
      >
        {props.label}
      </Text>
    </Button>
  );
}

export function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  multiline?: boolean;
  masked?: boolean;
  keyboard?: "default" | "url" | "numeric";
  autoCapitalize?: "none" | "sentences";
  onSubmit?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View class="gap-1.5">
      <Text class="text-sm font-semibold text-foreground">{props.label}</Text>
      <Input
        accessibilityLabel={props.label}
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        placeholder={props.placeholder}
        multiline={props.multiline}
        masked={props.masked}
        autoCorrect={!props.masked && props.autoCapitalize === "sentences"}
        keyboardType={props.keyboard ?? "default"}
        autoCapitalize={props.autoCapitalize ?? "none"}
        readonly={props.disabled}
        onSubmit={props.onSubmit}
        testID={props.testID}
        class={`min-h-11 rounded-md border border-input bg-card px-3 py-2.5 text-base text-foreground focus:border-ring ${props.multiline ? "min-h-28" : ""}`}
      />
      <If when={props.hint}>
        <Hint>{props.hint}</Hint>
      </If>
    </View>
  );
}

export type ChoiceItem = { value: string; title: string; disabled?: boolean };

export function Choice(props: {
  label: string;
  value: string | null;
  items: ChoiceItem[];
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <View class="gap-1.5">
      <Text class="text-sm font-semibold text-foreground">{props.label}</Text>
      <Select
        items={props.items}
        value={props.value}
        disabled={props.disabled}
        onChange={({ value }) =>
          props.onChange(typeof value === "string" ? value : null)
        }
        accessibilityLabel={props.label}
        offset={4}
        class="rounded-md focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        popupClass="rounded-xl border border-border bg-popover p-1.5 shadow-md"
        backdropClass="bg-foreground/30"
        itemClass="min-h-11 rounded-md px-3 py-2 text-sm text-popover-foreground focus:bg-muted selected:bg-accent disabled:opacity-50"
        trigger={
          <View class="min-h-11 flex-row items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2.5">
            <Text
              class={
                props.value == null
                  ? "flex-1 text-sm text-muted-foreground"
                  : "flex-1 text-sm text-foreground"
              }
            >
              {props.items.find((item) => item.value === props.value)?.title ??
                props.placeholder ??
                t("controls.select_an_option")}
            </Text>
            <Text class="text-sm text-muted-foreground">⌄</Text>
          </View>
        }
      />
    </View>
  );
}

export function Toggle(props: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      checked={props.checked}
      onChange={({ checked }) => props.onChange(checked)}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      class="min-h-11 flex-row items-center gap-3 self-start rounded-md focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      trackClass="w-11 rounded-full bg-muted p-0.5 border border-input checked:border-primary checked:bg-primary"
      thumbClass="size-4 rounded-full bg-foreground checked:bg-primary-foreground checked:translate-x-5 transition-transform duration-100 motion-reduce:transition-none"
    >
      <Text class="text-sm text-foreground">{props.label}</Text>
    </Switch>
  );
}

export function Hint(props: { children?: JSX.Element }) {
  return (
    <Text class="text-[13px] leading-5 text-muted-foreground">
      {props.children}
    </Text>
  );
}

export function Problem(props: { message: string }) {
  return (
    <If when={props.message}>
      <View
        role="alert"
        class="rounded-md border border-destructive px-3 py-2.5"
      >
        <Text class="text-sm leading-5 text-destructive">{props.message}</Text>
      </View>
    </If>
  );
}

export function ReadState(props: {
  loading: boolean;
  problem: string;
  empty: boolean;
  emptyLabel: string;
}) {
  return (
    <View class="gap-2">
      <Problem message={props.problem} />
      <If when={props.loading && props.empty}>
        <Hint>{t("controls.loading")}</Hint>
      </If>
      <If when={!props.loading && !props.problem && props.empty}>
        <View class="rounded-lg border border-border bg-card p-4">
          <Hint>{props.emptyLabel}</Hint>
        </View>
      </If>
    </View>
  );
}

export function Section(props: { title: string; children?: JSX.Element }) {
  return (
    <View class="gap-3">
      <Text role="header" class="text-[19px] font-semibold text-foreground">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

export function Panel(props: { children?: JSX.Element; class?: string }) {
  return (
    <View
      class={`gap-4 rounded-lg border border-border bg-card p-4 ${props.class ?? ""}`}
    >
      {props.children}
    </View>
  );
}

export async function confirm(
  title: string,
  message: string,
  label: string,
  destructive = true,
) {
  const result = await AlertDialog.show({
    title,
    description: message,
    actions: [
      { id: "cancel", label: t("common.cancel"), role: "cancel" },
      { id: "confirm", label, role: destructive ? "destructive" : "default" },
    ],
  });
  return result.action === "confirm";
}
