import { useEffect, useId, useRef, useState } from "react";
import {
  EuiAvatar, EuiButton, EuiButtonEmpty, EuiContextMenuItem, EuiContextMenuPanel, EuiFieldText, EuiIcon,
  EuiFilePicker, EuiFormRow, EuiModal, EuiModalBody, EuiModalFooter, EuiModalHeader, EuiModalHeaderTitle,
  EuiPopover, EuiText,
} from "@elastic/eui";
import { Api, ApiError, errorMessage } from "../api";
import { useT } from "../preferences";
import { Failure, Progress } from "./Common";

interface Profile { nickname: string | null; avatar: string | null }
const avatarTypes = ["image/png", "image/jpeg", "image/webp"];
const avatarLimit = 256 * 1024;

export function ProfileMenu({ api, username, security, signOut }: {
  api: Api; username: string; security: () => void; signOut: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [profile, setProfile] = useState<Profile>();
  const [failure, setFailure] = useState<string>();
  const [readAttempt, setReadAttempt] = useState(0);
  const name = profile?.nickname || username;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.read<Profile>("/auth/profile", controller.signal).then((result) => {
      if (!controller.signal.aborted) setProfile(result);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(errorMessage(error));
    });
    return () => controller.abort();
  }, [api, readAttempt]);

  function edit() {
    if (!profile && failure) {
      setFailure(undefined);
      setReadAttempt((attempt) => attempt + 1);
    }
    setMenuOpen(false);
    setEditOpen(true);
  }

  function closeEdit() {
    setEditOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  const trigger = <button ref={triggerRef} className="profile-trigger" type="button" aria-label={t("个人菜单")}
    aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
    {profile?.avatar ? <EuiAvatar size="s" name={name} imageUrl={profile.avatar} /> : <EuiAvatar size="s" name={name} />}
    <span className="profile-name">{name}</span>
    <EuiIcon className="profile-chevron" type="chevronSingleDown" size="s" />
  </button>;

  return <>
    <EuiPopover button={trigger} isOpen={menuOpen} closePopover={() => setMenuOpen(false)}
      anchorPosition="downRight" panelPaddingSize="none" ownFocus>
      <EuiContextMenuPanel items={[
        <EuiContextMenuItem key="profile" icon="user" onClick={edit}>{t("个人设置")}</EuiContextMenuItem>,
        <EuiContextMenuItem key="security" icon="lock" onClick={() => { setMenuOpen(false); security(); }}>{t("账号安全")}</EuiContextMenuItem>,
        <EuiContextMenuItem key="logout" icon="logOut" onClick={signOut}>{t("退出")}</EuiContextMenuItem>,
      ]} />
    </EuiPopover>
    {editOpen && <ProfileDialog api={api} profile={profile} username={username} loadFailure={failure}
      retry={() => { setFailure(undefined); setReadAttempt((attempt) => attempt + 1); }}
      close={closeEdit} saved={(next) => { setProfile(next); closeEdit(); }} />}
  </>;
}

function ProfileDialog({ profile, username, loadFailure, retry, close, api, saved }: {
  profile?: Profile; username: string; loadFailure?: string; retry: () => void; close: () => void;
  api: Api; saved: (profile: Profile) => void;
}) {
  const t = useT();
  const titleId = useId();
  return <EuiModal aria-labelledby={titleId} onClose={close} className="profile-dialog"
    maxWidth={440} initialFocus={profile ? "[name=nickname]" : undefined}>
    <EuiModalHeader><EuiModalHeaderTitle id={titleId}>{t("个人设置")}</EuiModalHeaderTitle></EuiModalHeader>
    {profile ? <ProfileForm api={api} profile={profile} username={username} close={close} saved={saved} />
      : <EuiModalBody>{loadFailure ? <Failure message={loadFailure} retry={retry} /> : <Progress />}</EuiModalBody>}
  </EuiModal>;
}

function ProfileForm({ api, profile, username, close, saved }: {
  api: Api; profile: Profile; username: string; close: () => void; saved: (profile: Profile) => void;
}) {
  const t = useT();
  const formId = useId();
  const [nickname, setNickname] = useState(profile.nickname ?? "");
  const [avatar, setAvatar] = useState(profile.avatar);
  const [pickId, setPickId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const name = nickname.trim() || username;
  const tooLong = Array.from(nickname.trim()).length > 64;
  const canSave = !busy && !loading && !tooLong &&
    ((nickname.trim() || null) !== profile.nickname || avatar !== profile.avatar);

  function choose(files: FileList | null) {
    const file = files?.[0];
    setFailure(undefined);
    if (!file) { setAvatar(profile.avatar); return; }
    if (file.size > avatarLimit || !avatarTypes.includes(file.type)) {
      setFailure("请选择 256 KiB 以内的 PNG、JPEG 或 WebP 图片。");
      setPickId((value) => value + 1);
      return;
    }
    const reader = new FileReader();
    setLoading(true);
    reader.onload = () => setAvatar(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => {
      setFailure("无法读取所选图片。");
      setPickId((value) => value + 1);
    };
    reader.onloadend = () => setLoading(false);
    reader.readAsDataURL(file);
  }

  return <>
    <EuiModalBody>
      <form id={formId} className="stack" onSubmit={async (event) => {
        event.preventDefault();
        if (!canSave) return;
        setFailure(undefined);
        setBusy(true);
        try {
          const result = await api.write<Profile>("/auth/profile", "PUT", { nickname: nickname.trim() || null, avatar });
          saved(result);
        } catch (error) {
          const code = error instanceof ApiError ? error.code : undefined;
          setFailure(code === "invalid_avatar" ? "请选择 256 KiB 以内、最长边不超过 1024 像素的 PNG、JPEG 或 WebP 图片。"
            : code === "invalid_nickname" ? "昵称应在 64 个字符以内，且不能包含控制字符。" : errorMessage(error));
        } finally {
          setBusy(false);
        }
      }}>
        <div className="profile-preview">
          {avatar ? <EuiAvatar size="xl" name={name} imageUrl={avatar} /> : <EuiAvatar size="xl" name={name} />}
          {avatar && <EuiButtonEmpty size="s" disabled={busy || loading} onClick={() => {
            setAvatar(null);
            setPickId((value) => value + 1);
            setFailure(undefined);
          }}>{t("移除头像")}</EuiButtonEmpty>}
        </div>
        <EuiFormRow label={t("头像")} fullWidth helpText={t("PNG、JPEG 或 WebP，最多 256 KiB。")}>
          <EuiFilePicker key={pickId} fullWidth display="default" aria-label={t("选择头像")} initialPromptText={t("选择头像")}
            accept={avatarTypes.join(",")} onChange={choose} disabled={busy || loading} />
        </EuiFormRow>
        <EuiFormRow label={t("昵称")} fullWidth isInvalid={tooLong}
          error={t("昵称最多 64 个字符。")}>
          <EuiFieldText name="nickname" fullWidth value={nickname} placeholder={username}
            isInvalid={tooLong} disabled={busy} onChange={(event) => setNickname(event.target.value)} />
        </EuiFormRow>
        <EuiText size="xs" color="subdued">{t("登录用户名 · {username}", { username })}</EuiText>
        <Failure message={failure} />
      </form>
    </EuiModalBody>
    <EuiModalFooter>
      <EuiButtonEmpty onClick={close}>{t("取消")}</EuiButtonEmpty>
      <EuiButton fill type="submit" form={formId} isLoading={busy} disabled={!canSave}>{t("保存")}</EuiButton>
    </EuiModalFooter>
  </>;
}
