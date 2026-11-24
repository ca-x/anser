import { Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { t } from "nsh/i18n";
import { ProfileAvatar } from "./ProfileAvatar";

export function AccountMenu(props: {
  name: string;
  avatar?: string | null;
  server?: string;
  onProfile: () => void;
  onSecurity: () => void;
}) {
  const itemClass =
    "min-h-11 justify-center rounded-(--radius) px-3 py-2 hover:bg-muted focus:bg-muted active:bg-accent";
  return (
    <Menu
      placement="top"
      align="start"
      offset={4}
      class={props.server ? "min-w-0" : "min-w-0 flex-1"}
      popupClass="min-w-44 rounded-(--radius) border border-border bg-popover p-1.5 shadow-md"
      backdropClass="bg-foreground/30"
      trigger={
        <View
          accessibilityLabel={t("profile.menu")}
          class="min-h-12 min-w-0 flex-row items-center gap-2 rounded-(--radius) px-2 py-1.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ProfileAvatar name={props.name} avatar={props.avatar} />
          <View class="min-w-0 flex-1 gap-0.5">
            <Text class="line-clamp-1 text-sm font-semibold text-foreground">
              {props.name}
            </Text>
            <If when={props.server}>
              <Text class="line-clamp-1 text-xs text-muted-foreground">
                {props.server}
              </Text>
            </If>
          </View>
          <Text
            accessibilityElementsHidden
            class="text-sm text-muted-foreground"
          >
            ⌄
          </Text>
        </View>
      }
    >
      <MenuItem class={itemClass} onSelect={props.onProfile}>
        <Text class="text-sm text-popover-foreground">
          {t("profile.title")}
        </Text>
      </MenuItem>
      <MenuItem class={itemClass} onSelect={props.onSecurity}>
        <Text class="text-sm text-popover-foreground">
          {t("security.title")}
        </Text>
      </MenuItem>
    </Menu>
  );
}
