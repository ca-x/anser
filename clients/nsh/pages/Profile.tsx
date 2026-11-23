import {
  effect,
  Picker,
  reduceMotion,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
  type Resource,
} from "nsh";
import { Dialog } from "nsh/base";
import { t } from "nsh/i18n";
import { ApiError, messageFor, type AnserApi } from "../api";
import { Action, Field, Hint, Problem } from "../components/Controls";
import { ProfileAvatar } from "../components/ProfileAvatar";
import type { PersonalProfile } from "../contracts";
import { operation } from "../state";

const maxAvatarSize = 256 * 1024;
function avatarType(bytes: Uint8Array) {
  const startsAt = (signature: number[], start = 0) =>
    signature.every((byte, index) => bytes[start + index] === byte);
  if (startsAt([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (startsAt([255, 216, 255])) return "image/jpeg";
  if (startsAt([82, 73, 70, 70]) && startsAt([87, 69, 66, 80], 8))
    return "image/webp";
}

export function Profile(props: {
  api: AnserApi;
  username: string;
  profile: Resource<PersonalProfile>;
  onBack: () => void;
}) {
  const busy = signal(false);
  return (
    <Dialog
      accessibilityLabel={t("profile.title")}
      animation={reduceMotion() ? "none" : "fade"}
      presentation="formSheet"
      backdropClass="bg-foreground/30"
      class="m-auto w-11/12 max-w-md rounded-xl border border-border bg-popover"
      closeOnSwipe={!busy()}
      closeOnEscape={!busy()}
      closeOnBackdropPress={!busy()}
      onOpenChange={({ open }) => {
        if (!open) props.onBack();
      }}
    >
      <Scroll style={{ maxHeight: Math.floor(windowSize().height * 0.8) }}>
        <View class="gap-4 p-5">
          <Text role="header" class="text-xl font-semibold text-foreground">
            {t("profile.title")}
          </Text>
          <If
            when={props.profile()}
            else={
              <>
                <If
                  when={props.profile.loading()}
                  else={
                    <>
                      <Problem message={messageFor(props.profile.error())} />
                      <Action
                        label={t("common.refresh")}
                        onPress={props.profile.refetch}
                        class="self-start"
                      />
                    </>
                  }
                >
                  <Hint>{t("controls.loading")}</Hint>
                </If>
                <Action
                  label={t("common.cancel")}
                  kind="quiet"
                  onPress={props.onBack}
                  class="self-start"
                />
              </>
            }
          >
            {(current) => (
              <ProfileEditor
                api={props.api}
                username={props.username}
                initial={current()}
                onBack={props.onBack}
                onBusy={busy.set}
                onSaved={(profile) => {
                  props.profile.mutate(profile);
                  props.onBack();
                }}
              />
            )}
          </If>
        </View>
      </Scroll>
    </Dialog>
  );
}

function ProfileEditor(props: {
  api: AnserApi;
  username: string;
  initial: PersonalProfile;
  onBack: () => void;
  onSaved: (profile: PersonalProfile) => void;
  onBusy: (busy: boolean) => void;
}) {
  const nickname = signal(props.initial.nickname ?? "");
  const avatar = signal(props.initial.avatar);
  const action = operation();
  const picking = operation();
  const busy = () => action.busy() || picking.busy();
  effect(() => props.onBusy(busy()));
  const changed = () =>
    (nickname().trim() || null) !== props.initial.nickname ||
    avatar() !== props.initial.avatar;

  function pick() {
    void picking.run(async () => {
      const [picked] = await Picker.pickFiles({
        filters: [
          {
            name: t("profile.avatar_formats"),
            extensions: ["png", "jpg", "jpeg", "webp"],
          },
        ],
        maxSize: maxAvatarSize,
      });
      if (!picked || !picking.live()) return;
      if (!picked.file || picked.size > maxAvatarSize)
        throw new ApiError("avatar_too_large", t("profile.avatar_too_large"));
      const bytes = new Uint8Array(await picked.file.arrayBuffer());
      if (!picking.live()) return;
      const mime = avatarType(bytes);
      if (!mime)
        throw new ApiError("invalid_avatar", t("profile.invalid_avatar"));
      let data = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        data += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      avatar.set(`data:${mime};base64,${btoa(data)}`);
    });
  }

  function save() {
    if (!changed() || busy()) return;
    void action.run(async () => {
      const name = nickname().trim();
      if ([...name].length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(name))
        throw new ApiError("invalid_nickname", t("profile.nickname_limit"));
      const result = await props.api.saveProfile({
        nickname: name || null,
        avatar: avatar(),
      });
      if (action.live()) props.onSaved(result);
    });
  }

  return (
    <>
      <Problem message={picking.problem() || action.problem()} />
      <View class="flex-row flex-wrap items-center gap-3">
        <ProfileAvatar
          name={nickname().trim() || props.username}
          avatar={avatar()}
          class="size-14"
        />
        <View class="min-w-0 flex-1 gap-1">
          <Hint>{t("connection.username")}</Hint>
          <Text class="text-base font-semibold text-foreground">
            {props.username}
          </Text>
        </View>
      </View>
      <View class="flex-row flex-wrap gap-2">
        <Action
          label={t("profile.choose_avatar")}
          onPress={pick}
          disabled={busy()}
        />
        <If when={avatar()}>
          <Action
            label={t("profile.remove_avatar")}
            onPress={() => {
              avatar.set(null);
              picking.problem.set("");
            }}
            kind="quiet"
            disabled={busy()}
          />
        </If>
      </View>
      <Hint>{t("profile.avatar_size")}</Hint>
      <Field
        label={t("profile.nickname")}
        value={nickname()}
        hint={t("profile.nickname_hint")}
        onChange={nickname.set}
        disabled={busy()}
      />
      <View class="flex-row flex-wrap gap-2">
        <Action
          label={t(action.busy() ? "common.saving" : "profile.save")}
          kind="primary"
          onPress={save}
          disabled={busy() || !changed()}
        />
        <Action
          label={t("common.cancel")}
          kind="quiet"
          onPress={props.onBack}
          disabled={busy()}
        />
      </View>
    </>
  );
}
