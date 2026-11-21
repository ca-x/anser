import { useEffect, useMemo, useRef, useState } from "react";
import { EuiButton, EuiButtonEmpty, EuiCallOut, EuiCopy, EuiFieldText, EuiFormRow, EuiText } from "@elastic/eui";
import { QRCodeCanvas } from "qrcode.react";
import { Api, errorMessage, type PairCode } from "../api";
import { Failure, PageTitle } from "../components/Common";
import { readPairing, type PairingState } from "../pairing";
import { useLanguage, useT } from "../preferences";

export default function Pair({ api, username }: { api: Api; username: string }) {
  const t = useT();
  const language = useLanguage();
  const time = useMemo(() => new Intl.DateTimeFormat(language, { timeStyle: "medium" }), [language]);
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
      const reply = await api.write<PairCode>("/auth/pair", "POST", { server: server.trim() });
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
  </>;
}
