import { useState } from "react";
import { EuiBadge, EuiButton, EuiButtonEmpty, EuiFieldSearch, EuiFormRow, EuiLink } from "@elastic/eui";
import { Api, segment } from "../api";
import { Empty, Failure, More, Progress } from "../components/Common";
import { useT } from "../preferences";
import { usePage } from "../resources";
import { PluginsWorkspace } from "./Channels";

type Repository = { full_name: string; description?: string | null; stargazers_count: number };
const validRepository = /^[a-z0-9-]+\/[a-z0-9_.-]+$/i;

export default function GithubMarket({ api, navigate }: { api: Api; navigate: (path: string) => void }) {
  const t = useT();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  return <PluginsWorkspace tab="market" navigate={navigate}>
    <div className="section-header"><div className="stack">
      <h2>{t("在 GitHub 发现插件")}</h2>
      <p className="muted">{t("浏览带有 anser-plugin 标签的公开仓库，打开仓库查看使用或安装说明。")}</p>
    </div>
    <EuiButtonEmpty size="s" onClick={() => navigate("/admin/channels/announcements")}>{t("主题插件公告")}</EuiButtonEmpty>
    </div>
    <form className="plugin-search" onSubmit={(event) => {
      event.preventDefault(); setQuery(input.trim());
    }}>
      <EuiFormRow label={t("搜索 GitHub 插件")} fullWidth>
        <EuiFieldSearch fullWidth value={input} maxLength={120}
          onChange={(event) => setInput(event.target.value)} />
      </EuiFormRow>
      <EuiButton type="submit" iconType="search">{t("搜索")}</EuiButton>
    </form>
    <Results api={api} query={query} key={query} />
  </PluginsWorkspace>;
}

function Results({ api, query }: { api: Api; query: string }) {
  const t = useT();
  const list = usePage<Repository>(api, `/plugins/market?q=${segment(query)}`);
  const repositories = list.items.filter(({ full_name }) => validRepository.test(full_name));
  return <>
    <Failure message={list.error} retry={list.reload} />
    {list.loading ? <Progress /> : repositories.length ? <ul className="plugin-grid">
      {repositories.map((repo) => <li className="plugin-tile" key={repo.full_name}>
        <div className="plugin-tile-meta"><EuiBadge iconType="starEmpty">{repo.stargazers_count}</EuiBadge></div>
        <h3><EuiLink href={`https://github.com/${repo.full_name}`} external target="_blank" rel="noopener noreferrer">
          {repo.full_name}
        </EuiLink></h3>
        {repo.description && <p className="muted">{repo.description}</p>}
      </li>)}
    </ul> : !list.error && <Empty title={t("没有找到 GitHub 插件")} description={t("试试其他关键词，或清空搜索查看全部结果。")} />}
    <More next={list.next} busy={list.busy} load={() => void list.loadMore()} />
  </>;
}
