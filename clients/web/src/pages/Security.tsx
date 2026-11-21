import { useId, useState } from "react";
import { EuiBadge, EuiButton, EuiButtonEmpty, EuiCopy, EuiFieldPassword, EuiFieldText, EuiFormRow, EuiText } from "@elastic/eui";
import { QRCodeCanvas } from "qrcode.react";
import { Api, ApiError, type TotpConfirmation, type TotpSetup, type TotpStatus } from "../api";
import { Drawer, Failure, PageTitle, Progress, useDate } from "../components/Common";
import { useT } from "../preferences";
import { useMutation, useResource } from "../resources";

export function Security({ api }: { api: Api }) {
  const t = useT();
  const status = useResource<TotpStatus>(api, "/auth/totp");
  const [operation, setOperation] = useState<"setup" | "disable">();
  const close = () => setOperation(undefined);
  return <>
    <PageTitle title={t("账号安全")} />
    <Failure message={status.error} retry={status.reload} />
    {status.loading && <Progress />}
    {status.data && <section className="security-settings" aria-label={t("双重验证")}>
      <div className="security-settings-header">
        <h2>{t("双重验证")}</h2>
        <EuiBadge color={status.data.enabled ? "success" : "default"}>{t(status.data.enabled ? "已启用" : "未启用")}</EuiBadge>
      </div>
      <EuiText size="s" color="subdued"><p>{t("登录时，除了密码，还需输入验证器应用生成的验证码或一条恢复代码。")}</p></EuiText>
      {status.data.enabled
        ? <EuiButton color="danger" size="s" onClick={() => setOperation("disable")}>{t("停用双重验证")}</EuiButton>
        : <EuiButton fill size="s" onClick={() => setOperation("setup")}>{t("设置双重验证")}</EuiButton>}
    </section>}
    {operation === "setup" && <Enroll api={api} close={close} changed={status.reload} />}
    {operation === "disable" && <Disable api={api} close={close} changed={status.reload} />}
  </>;
}

function Enroll({ api, close, changed }: { api: Api; close: () => void; changed: () => void }) {
  const t = useT();
  const date = useDate();
  const id = useId();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TotpSetup>();
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>();
  const task = useMutation();
  const closeWhenIdle = () => { if (!task.busy) close(); };

  if (recovery) return <Drawer size="s" title={t("保存恢复代码")} close={close}
    footer={<EuiButton fill onClick={close}>{t("完成")}</EuiButton>}>
    <div className="stack totp-recovery">
      <EuiText size="s"><p>{t("恢复代码仅在此处显示一次。每条代码只能使用一次，请保存在安全的位置。")}</p></EuiText>
      <ul className="totp-recovery-list">{recovery.map((entry) => <li key={entry}><code>{entry}</code></li>)}</ul>
      <EuiCopy textToCopy={recovery.join("\n")} afterMessage={t("已复制")}>
        {(copy: () => void) => <EuiButtonEmpty iconType="copy" onClick={copy}>{t("复制恢复代码")}</EuiButtonEmpty>}
      </EuiCopy>
    </div>
  </Drawer>;

  return <Drawer size="s" title={t("设置双重验证")} close={closeWhenIdle}
    footer={<>
      <EuiButtonEmpty disabled={task.busy} onClick={closeWhenIdle}>{t("取消")}</EuiButtonEmpty>
      <EuiButton fill type="submit" form={id} isLoading={task.busy}>{t(setup ? "确认并启用" : "继续")}</EuiButton>
    </>}>
    <form id={id} className="stack totp-setup" onSubmit={(event) => {
      event.preventDefault();
      void task.run(async () => {
        if (!setup) {
          try {
            setSetup(await api.write<TotpSetup>("/auth/totp/setup", "POST", { password }));
          } catch (error) {
            if (error instanceof ApiError && error.code === "totp_already_enabled") changed();
            throw error;
          } finally {
            setPassword("");
          }
          return;
        }
        try {
          const result = await api.write<TotpConfirmation>("/auth/totp/confirm", "POST", { code: code.trim() });
          setSetup(undefined);
          setRecovery(result.recovery_codes);
        } catch (error) {
          if (error instanceof ApiError && (error.code === "totp_setup_expired" || error.code === "totp_already_enabled")) {
            setSetup(undefined);
          }
          throw error;
        } finally {
          setCode("");
          changed();
        }
      });
    }}>
      <Failure message={task.error} />
      {setup ? <>
        <EuiText size="s"><p>{t("用验证器应用扫描二维码，或手动输入设置密钥。")}</p></EuiText>
        <div className="totp-qr"><QRCodeCanvas size={200} marginSize={4} value={setup.uri} title={t("验证器设置二维码")} /></div>
        <div className="totp-secret">
          <EuiText size="s"><p>{t("设置密钥")}</p></EuiText>
          <code className="new-token">{setup.secret}</code>
          <EuiCopy textToCopy={setup.secret} afterMessage={t("已复制")}>
            {(copy: () => void) => <EuiButtonEmpty iconType="copy" onClick={copy}>{t("复制设置密钥")}</EuiButtonEmpty>}
          </EuiCopy>
        </div>
        <EuiFormRow label={t("验证码")} helpText={t("输入验证器生成的 6 位验证码。设置有效期至 {time}。", { time: date(setup.expires_at) })} fullWidth>
          <EuiFieldText autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required fullWidth
            readOnly={task.busy} value={code} onChange={(event) => setCode(event.target.value)} />
        </EuiFormRow>
      </> : <CurrentPassword busy={task.busy} value={password} update={setPassword} />}
    </form>
  </Drawer>;
}

function Disable({ api, close, changed }: { api: Api; close: () => void; changed: () => void }) {
  const t = useT();
  const id = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const task = useMutation();
  const closeWhenIdle = () => { if (!task.busy) close(); };

  return <Drawer size="s" title={t("停用双重验证")} close={closeWhenIdle}
    footer={<>
      <EuiButtonEmpty disabled={task.busy} onClick={closeWhenIdle}>{t("取消")}</EuiButtonEmpty>
      <EuiButton color="danger" fill type="submit" form={id} isLoading={task.busy}>{t("停用双重验证")}</EuiButton>
    </>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault();
      void task.run(async () => {
        try {
          await api.write<TotpStatus>("/auth/totp/disable", "POST", { password, code: code.trim() });
          changed();
          close();
        } catch (error) {
          if (error instanceof ApiError && error.code === "totp_not_enabled") changed();
          throw error;
        } finally {
          setPassword("");
          setCode("");
        }
      });
    }}>
      <Failure message={task.error} />
      <EuiText size="s"><p>{t("停用后，登录只需密码，现有恢复代码随即失效。")}</p></EuiText>
      <CurrentPassword busy={task.busy} value={password} update={setPassword} />
      <EuiFormRow label={t("验证码或恢复代码")} fullWidth>
        <EuiFieldText autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required fullWidth
          readOnly={task.busy} value={code} onChange={(event) => setCode(event.target.value)} />
      </EuiFormRow>
    </form>
  </Drawer>;
}

function CurrentPassword({ value, update, busy }: { value: string; update: (value: string) => void; busy: boolean }) {
  const t = useT();
  return <EuiFormRow label={t("当前密码")} fullWidth>
    <EuiFieldPassword required fullWidth type="password" autoComplete="current-password" readOnly={busy}
      value={value} onChange={(event) => update(event.target.value)} />
  </EuiFormRow>;
}
