import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiCallOut, EuiCopy, EuiFieldText, EuiFormRow, EuiText } from "@elastic/eui";
import { QRCodeCanvas } from "qrcode.react";
import { Api, errorMessage, segment, type PairCode, type PairedClient } from "../api";
import { Confirm, Drawer, Empty, Failure, More, PageTitle, Progress, RowAction, useDate } from "../components/Common";
import { readPairing, type PairingState } from "../pairing";
import { useMutation, usePage } from "../resources";
import { useLanguage, useT } from "../preferences";

export default function Pair({ api, username }: { api: Api; username: string }) {
  const t = useT();
  const language = useLanguage();
  const time = useMemo(() => new Intl.DateTimeFormat(language, { timeStyle: "medium" }), [language]);
  const [name, setName] = useState("");
  const [server, setServer] = useState(window.location.origin);
  const [pair, setPair] = useState<PairingState>({ status: "idle" });
  const revision = useRef(0);
  const generateButton = useRef<HTMLButtonElement>(null);
  const codePanel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (pair.status !== "ready") return;
    function expire() {
      if (pair.status !== "ready" || Date.now() < pair.expires) return;
      if (codePanel.current?.contains(document.activeElement)) generateButton.current?.focus();
      setPair((current) => current === pair ? { status: "expired" } : current);
    }
    const timer = window.setTimeout(expire, Math.max(0, pair.expires - Date.now()));
    window.addEventListener("pageshow", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pageshow", expire);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [pair]);

  async function generate() {
    if (pair.status === "loading") return;
    const request = ++revision.current;
    setPair({ status: "loading" });
    try {
      const reply = await api.write<PairCode>("/auth/pair", "POST", { server: server.trim(), name: name.trim() || undefined });
      if (request === revision.current) setPair(readPairing(reply, Date.now()));
    } catch (error) {
      if (request === revision.current) setPair({ status: "error", message: errorMessage(error) });
    }
  }

  return <>
    <PageTitle title={t("配对客户端")} description={t("在另一台设备上登录为 {name}。", { name: username })} />
    <div className="pair-layout">
      <form className="form-surface stack" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
        <EuiFormRow label={t("客户端可访问的服务器地址")} helpText={t("服务器配置了 ANSER_PUBLIC_URL 时，以服务端配置为准。")} fullWidth>
          <EuiFieldText fullWidth type="url" required spellCheck={false} autoCapitalize="none" value={server} onChange={(event) => {
            revision.current++;
            setServer(event.target.value);
            setPair({ status: "idle" });
          }} />
        </EuiFormRow>
        <EuiFormRow label={t("设备备注（可选）")} fullWidth>
          <EuiFieldText fullWidth maxLength={80} value={name} placeholder={t("例如，办公室电脑")} onChange={(event) => {
            revision.current++;
            setName(event.target.value);
            setPair({ status: "idle" });
          }} />
        </EuiFormRow>
        {pair.status === "error" && <Failure message={pair.message} />}
        {pair.status === "expired" && <EuiCallOut announceOnMount size="s" color="warning" iconType="clock" title={t("配对码已过期，请生成新码。")} />}
        <div className="form-actions"><EuiButton buttonRef={generateButton} type="submit" fill iconType="link" isLoading={pair.status === "loading"}>
          {t(pair.status === "expired" || pair.status === "ready" ? "重新生成配对码" : "生成配对码")}
        </EuiButton></div>
      </form>
      {pair.status === "ready" && <section ref={codePanel} className="pair-code stack" aria-label={t("配对二维码")}>
        <h2 role="status">{t("用系统相机扫码")}</h2>
        <QRCodeCanvas value={pair.link} size={228} marginSize={4} title={t("雁字客户端配对二维码")} />
        <strong className="pair-origin" dir="ltr">{pair.origin}</strong>
        <EuiText textAlign="center" size="s" color="subdued"><p>{t("有效期至 {time}，配对码仅可使用一次。", { time: time.format(pair.expires) })}</p></EuiText>
        <div className="pair-import">
          <EuiCopy textToCopy={pair.link} afterMessage={t("已复制")}>
            {(copy: () => void) => <EuiButtonEmpty iconType="copy" onClick={() => {
              if (Date.now() < pair.expires) copy();
              else { setPair({ status: "expired" }); generateButton.current?.focus(); }
            }}>{t("复制配对链接")}</EuiButtonEmpty>}
          </EuiCopy>
          <EuiText textAlign="center" size="xs" color="subdued"><p>{t("也可在客户端连接页选择「导入连接链接」。")}</p></EuiText>
        </div>
      </section>}
    </div>
    <PairedClients api={api} awaitingPair={pair.status === "ready"} />
  </>;
}

function PairedClients({ api, awaitingPair }: { api: Api; awaitingPair: boolean }) {
  const t = useT();
  const date = useDate();
  const clients = usePage<PairedClient>(api, "/auth/paired-clients");
  const [editing, setEditing] = useState<PairedClient>();
  const [revoking, setRevoking] = useState<PairedClient>();
  const revoke = useMutation();
  const reload = clients.reload;
  const polling = awaitingPair && !clients.fetching && !clients.busy && !editing && !revoking;
  useEffect(() => {
    if (!polling) return;
    let timer: number | undefined;
    function schedule() {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") timer = window.setTimeout(reload, 5000);
    }
    function resume() {
      if (document.visibilityState === "visible") reload();
      schedule();
    }
    schedule();
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [polling, reload]);
  const heading = useId();
  return <section className="stack paired-clients" aria-labelledby={heading}>
    <div className="section-header"><h2 id={heading}>{t("已配对客户端")}</h2>
      <EuiButtonEmpty size="s" iconType="refresh" onClick={clients.reload}>{t("刷新")}</EuiButtonEmpty>
    </div>
    <Failure message={clients.error} retry={clients.reload} />
    {clients.loading ? <Progress /> : clients.items.length > 0 ? <div className="data-surface">
      <EuiBasicTable<PairedClient> items={clients.items} itemId="id" rowHeader="name" tableCaption={t("已配对客户端")} columns={[
        { field: "name", name: t("设备备注"), render: (name: string) => name || t("未命名设备") },
        { field: "username", name: t("所属用户") },
        { name: t("状态"), render: (item: PairedClient) => {
          const active = item.enabled && item.expires_at > Date.now();
          return <EuiBadge color={active ? "success" : "default"}>{t(!item.enabled ? "已撤销" : active ? "已配对" : "已过期")}</EuiBadge>;
        } },
        { field: "created_at", name: t("配对时间"), render: date },
        { field: "last_used_at", name: t("最近使用"), render: date },
        { field: "expires_at", name: t("到期时间"), render: date },
        { name: t("操作"), render: (item: PairedClient) => <div className="row-actions">
          <RowAction icon="pencil" onClick={() => setEditing(item)}>{t("修改备注")}</RowAction>
          {item.enabled && <RowAction danger icon="linkSlash" onClick={() => { revoke.clear(); setRevoking(item); }}>{t("撤销配对")}</RowAction>}
        </div> },
      ]} />
      <More next={clients.next} busy={clients.busy} load={() => void clients.loadMore()} />
    </div> : !clients.error && <Empty title={t("暂无已配对客户端")} description={t("客户端扫码登录后，可在这里查看设备和管理访问权限。")} />}
    {editing && <RenameClient api={api} item={editing} close={() => setEditing(undefined)} done={clients.reload} />}
    {revoking && <Confirm title={t("撤销与「{name}」的配对？", { name: revoking.name || t("未命名设备") })} label={t("撤销配对")}
      busy={revoke.busy} close={() => { if (!revoke.busy) setRevoking(undefined); }} confirm={() => void revoke.run(async () => {
        await api.write(`/auth/paired-clients/${segment(revoking.id)}`, "DELETE");
        setRevoking(undefined);
        clients.reload();
      })}>
      <p>{t("该设备需要重新登录才能访问此服务器。")}</p><Failure message={revoke.error} />
    </Confirm>}
  </section>;
}

function RenameClient({ api, item, close, done }: { api: Api; item: PairedClient; close: () => void; done: () => void }) {
  const t = useT();
  const [name, setName] = useState(item.name);
  const task = useMutation();
  const form = useId();
  return <Drawer size="s" title={t("修改备注")} close={() => { if (!task.busy) close(); }} footer={<>
    <EuiButtonEmpty disabled={task.busy} onClick={close}>{t("取消")}</EuiButtonEmpty>
    <EuiButton fill isLoading={task.busy} form={form} type="submit" disabled={!name.trim() || name.trim() === item.name}>{t("保存")}</EuiButton>
  </>}>
    <form id={form} className="stack" onSubmit={(event) => {
      event.preventDefault();
      if (!name.trim() || name.trim() === item.name) return;
      void task.run(async () => {
        await api.write(`/auth/paired-clients/${segment(item.id)}`, "PATCH", { name: name.trim() });
        done();
        close();
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("设备备注")} fullWidth>
        <EuiFieldText required fullWidth maxLength={80} readOnly={task.busy} value={name} onChange={(event) => setName(event.target.value)} />
      </EuiFormRow>
    </form>
  </Drawer>;
}
