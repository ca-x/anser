import { Avatar } from "nsh/base";

const maxAvatarData = 360_000;
const imageDataUrl =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function ProfileAvatar(props: {
  name: string;
  avatar?: string | null;
  class?: string;
}) {
  const src = () => {
    const avatar = props.avatar;
    return avatar && avatar.length <= maxAvatarData && imageDataUrl.test(avatar)
      ? avatar
      : null;
  };
  return (
    <Avatar
      name={props.name}
      src={src()}
      accessibilityLabel=""
      class={`shrink-0 overflow-hidden rounded-full ${props.class ?? "size-8"}`}
      fallbackClass="items-center justify-center bg-muted text-sm font-semibold text-foreground"
      imageClass="object-cover"
    />
  );
}
