import { t } from "nsh/i18n";
import { Image, Scroll, Text, View, type JSX } from "nsh";
import { NavPage } from "nsh/base";
import { Action } from "./Controls";
import logo from "../assets/logo.png";

export function Brand(props: { compact?: boolean }) {
  return (
    <View
      class={
        props.compact
          ? "flex-row items-center gap-2.5"
          : "flex-row items-center gap-3.5"
      }
    >
      <Image
        src={logo}
        fadeDuration={0}
        class={props.compact ? "size-10" : "size-16"}
      />
      <Text
        class={
          props.compact
            ? "text-lg font-semibold text-foreground"
            : "text-[26px] font-semibold text-foreground"
        }
      >
        {t("workspace.anser")}
      </Text>
    </View>
  );
}

export function WorkspacePage(props: {
  title: string;
  back?: () => void;
  children?: JSX.Element;
  footer?: JSX.Element;
}) {
  return (
    <NavPage
      title={props.title}
      header={
        <View class="min-h-14 flex-row items-center gap-3 border-b border-border bg-card px-4 md:px-6">
          <If when={props.back}>
            <Action
              label={t("workspace.back")}
              onPress={() => props.back?.()}
              kind="quiet"
            />
          </If>
          <Text
            role="header"
            class="flex-1 text-[22px] font-semibold text-foreground"
          >
            {props.title}
          </Text>
        </View>
      }
    >
      <View class="flex-1 bg-background">
        <Scroll class="flex-1" keyboardDismissMode="on-drag">
          <View class="w-full max-w-4xl self-center gap-5 px-4 pt-5 pb-8 md:px-8 md:pt-7">
            {props.children}
          </View>
        </Scroll>
        <If when={props.footer}>
          <View class="border-t border-border bg-card px-4 py-2 md:px-8">
            <View class="w-full max-w-4xl self-center">{props.footer}</View>
          </View>
        </If>
      </View>
    </NavPage>
  );
}

export function RecordRow(props: {
  title: string;
  subtitle?: string;
  status?: JSX.Element;
  onPress?: () => void;
  action?: { label: string; accessibilityLabel: string };
  class?: string;
}) {
  return (
    <View
      class={`min-h-14 flex-row items-center gap-3 border-b border-border px-3 py-2 ${props.class ?? ""}`}
    >
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="text-base font-medium text-foreground">{props.title}</Text>
        <If when={props.subtitle}>
          <Text class="text-[13px] text-muted-foreground">
            {props.subtitle}
          </Text>
        </If>
      </View>
      {props.status}
      <If when={props.onPress}>
        <Action
          label={props.action?.label ?? t("workspace.view")}
          accessibilityLabel={props.action?.accessibilityLabel}
          onPress={() => props.onPress?.()}
          kind="quiet"
        />
      </If>
    </View>
  );
}
