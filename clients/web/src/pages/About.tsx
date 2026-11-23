import { useState } from "react";
import { EuiIcon, EuiLink } from "@elastic/eui";
import type { Api } from "../api";
import logo from "../assets/logo.png";
import { Failure, Progress } from "../components/Common";
import { useT } from "../preferences";
import { useResource } from "../resources";
import "./about.css";

const project = "https://github.com/ca-x/anser";

export default function About({ api }: { api: Api }) {
  const t = useT();
  const info = useResource<{ version: string }>(api, "/info");
  const [expanded, setExpanded] = useState(false);

  return <article className="about-sheet">
    <header className="about-intro">
      <button type="button" className="about-mark" aria-expanded={expanded} aria-controls="about-story"
        onClick={() => setExpanded(!expanded)}>
        <img src={logo} width="116" height="116" alt="" />
        <span>{t("标志的由来")} <EuiIcon type={expanded ? "chevronSingleUp" : "chevronSingleDown"} size="s" /></span>
      </button>
      <div className="page-title"><div>
        <h1>{t("关于雁字")}</h1>
        <p>{t("从自己的服务器，把通知送到订阅的主题、设备和个人收件箱。")}</p>
      </div></div>
    </header>
    <p id="about-story" className="about-story" hidden={!expanded}>
      {t("古人以鸿雁传书。标志中从信封上展翅的雁，沿用了这一意象。")}
    </p>
    <dl className="about-facts">
      <div>
        <dt>{t("服务端版本")}</dt>
        <dd>
          {info.loading && <Progress />}
          <Failure message={info.error} retry={info.reload} />
          {info.data && <><strong className="about-version">{info.data.version}</strong>
            <EuiLink href={`${project}/releases/tag/v${encodeURIComponent(info.data.version)}`} external>
              {t("发布说明")}
            </EuiLink></>}
        </dd>
      </div>
      <div><dt>{t("源代码")}</dt><dd><EuiLink href={project} external>GitHub</EuiLink></dd></div>
      <div><dt>{t("软件许可")}</dt><dd>
        <EuiLink href={`${project}/blob/main/LICENSE`} external>Apache 2.0</EuiLink>
        <EuiLink href={`${import.meta.env.BASE_URL}licenses/EUI-LICENSE.txt`}>{t("Elastic UI 许可")}</EuiLink>
      </dd></div>
    </dl>
  </article>;
}
