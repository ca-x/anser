import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { ArrowDown, ArrowDownRight, ArrowSquareOut, Code, DesktopTower, EnvelopeSimple, FlowArrow, GithubLogo, Globe, ListChecks, Package, SunDim } from "@phosphor-icons/react";
import "@cloudflare/kumo/styles/kumo-standalone";
import "./style.css";
import { copy } from "./copy";
import { SdkGuide } from "./SdkGuide";
import logo from "../../clients/web/src/assets/logo.png";
import consoleZh from "../../docs/screenshots/zh-CN/server-overview.png";
import consoleEn from "../../docs/screenshots/en/server-overview.png";

const repo = "https://github.com/ca-x/anser";
const latest = repo + "/releases/latest/download/";
const serverAssets = [
  "anser-x86_64-unknown-linux-gnu.tar.gz", "anser-aarch64-unknown-linux-gnu.tar.gz",
  "anser-aarch64-apple-darwin.tar.gz", "anser-x86_64-apple-darwin.tar.gz",
  "anser-x86_64-pc-windows-msvc.zip",
];
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function saved(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function retain(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Preferences remain valid for this page. */ }
}

function Asset({ href, children, external = false }) {
  const Icon = external ? ArrowSquareOut : ArrowDown;
  return <li><a className="asset" href={href}><span>{children}</span><Icon size={16} aria-hidden="true" /></a></li>;
}

function DownloadCard({ icon: Icon, title, description, children }) {
  return <LayerCard className="download-card">
    <Icon className="section-icon" size={24} aria-hidden="true" />
    <div className="download-heading"><h3>{title}</h3><p>{description}</p></div>
    <ul className="asset-list">{children}</ul>
  </LayerCard>;
}

function Website() {
  const [language, setLanguage] = useState(() => {
    const requested = new URLSearchParams(location.search).get("lang");
    if (requested === "en" || requested === "zh-CN") return requested;
    const preference = saved("anser.website.lang");
    return preference === "en" || preference === "zh-CN" ? preference : navigator.language.startsWith("zh") ? "zh-CN" : "en";
  });
  const [theme, setTheme] = useState(() => {
    const preference = saved("anser.website.theme");
    return preference === "light" || preference === "dark" ? preference : "system";
  });
  const t = copy[language];
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t.title;
    document.querySelector('meta[name="description"]').content = t.description;
  }, [language, t]);
  useEffect(() => {
    const apply = () => {
      const mode = theme === "system" ? systemDark.matches ? "dark" : "light" : theme;
      document.documentElement.dataset.mode = mode;
      document.documentElement.style.colorScheme = mode;
    };
    apply();
    systemDark.addEventListener("change", apply);
    return () => systemDark.removeEventListener("change", apply);
  }, [theme]);

  return <>
    <a className="skip" href="#main">{t.skip}</a>
    <header className="top">
      <nav className="wrap top-inner" aria-label={t.name}>
        <a className="brand" href="#"><img src={logo} width="38" height="38" alt="" />{t.name}</a>
        <div className="nav-links"><a href="#features">{t.features}</a><a href="#usage">{t.usage}</a><a href="#downloads">{t.downloads}</a><a href="#sdk">{t.sdk}</a></div>
        <div className="prefs">
          <label className="preference"><Globe size={17} aria-hidden="true" />
            <select aria-label={t.language} value={language} onChange={(e) => {
              const next = e.currentTarget.value;
              setLanguage(next);
              retain("anser.website.lang", next);
              const url = new URL(location.href);
              url.searchParams.set("lang", next);
              history.replaceState(null, "", url);
            }}><option value="zh-CN">简体中文</option><option value="en">English</option></select>
          </label>
          <label className="preference"><SunDim size={18} aria-hidden="true" />
            <select aria-label={t.theme} value={theme} onChange={(e) => {
              setTheme(e.currentTarget.value); retain("anser.website.theme", e.currentTarget.value);
            }}><option value="system">{t.system}</option><option value="light">{t.light}</option><option value="dark">{t.dark}</option></select>
          </label>
          <LinkButton className="repo-link" aria-label={t.source} href={repo} variant="ghost" shape="square" icon={GithubLogo} />
        </div>
      </nav>
    </header>
    <main id="main">
      <section className="wrap hero">
        <div className="hero-copy">
          <h1>{t.headline}</h1>
          <p>{t.description}</p>
          <div className="hero-actions">
            <LinkButton href="#downloads" variant="primary" size="lg" icon={ArrowDown}>{t.primary}</LinkButton>
            <LinkButton href="#features" variant="secondary" size="lg" icon={ArrowDownRight}>{t.preview}</LinkButton>
          </div>
        </div>
        <figure className="console">
          <img src={language === "zh-CN" ? consoleZh : consoleEn} alt={t.imageAlt} fetchPriority="high" width="1320" height="830" />
          <figcaption><DesktopTower size={16} aria-hidden="true" />{t.console}</figcaption>
        </figure>
      </section>
      <section className="feature-band" id="features">
        <div className="wrap section">
          <h2>{t.featuresTitle}</h2>
          <div className="feature-grid">
            {t.featuresList.map(([title, body], i) => {
              const Icon = [Code, FlowArrow, ListChecks][i];
              return <article className="feature" key={title}>
                <Icon size={24} className="section-icon" aria-hidden="true" /><h3>{title}</h3><p>{body}</p>
              </article>;
            })}
          </div>
          <div className="channels">
            <h3><EnvelopeSimple size={19} aria-hidden="true" />{t.channelsTitle}</h3>
            <ul>{t.channels.map((channel) => <li key={channel}>{channel}</li>)}</ul>
          </div>
        </div>
      </section>
      <section className="wrap section" id="usage">
        <h2>{t.usageTitle}</h2>
        <div className="usage-grid">
          {t.usageCards.map(([title, detail, label, path]) =>
            <article className="feature usage-card" key={title}>
              <h3>{title}</h3>
              <p>{detail}</p>
              {path && <a href={`${repo}/blob/main/${path}`}>{label}<ArrowSquareOut size={15} aria-hidden="true" /></a>}
            </article>
          )}
        </div>
      </section>
      <section className="wrap section" id="downloads">
        <div className="section-heading">
          <h2>{t.downloadTitle}</h2>
          <a href={repo + "/releases"}>{t.releases} <ArrowSquareOut size={15} aria-hidden="true" /></a>
        </div>
        <div className="download-grid">
          <DownloadCard icon={DesktopTower} title={t.server} description={t.serverDescription}>
            {serverAssets.map((name, index) => <Asset key={name} href={latest + name}>{t.platforms[index]}</Asset>)}
          </DownloadCard>
          <DownloadCard icon={Package} title={t.client} description={t.clientDescription}>
            <Asset href={latest + "anser-client-linux-x86_64.tar.gz"}>{t.platforms[0]}</Asset>
            <Asset href={latest + "anser-client-web.tar.gz"}>{t.clientWeb}</Asset>
            <Asset href="https://github.com/lazycat-contrib/anser-lzcapp/releases/latest" external>{t.lazycat}</Asset>
          </DownloadCard>
          <DownloadCard icon={Code} title={t.docker} description={t.dockerDescription}>
            <Asset href="https://github.com/ca-x/anser/pkgs/container/anser" external>{t.image}</Asset>
            <Asset href={latest + "anser-docker-linux-amd64.tar.gz"}>{t.platforms[0]}</Asset>
            <Asset href={latest + "anser-docker-linux-arm64.tar.gz"}>{t.platforms[1]}</Asset>
          </DownloadCard>
        </div>
        <a className="checksum" href={latest + "SHA256SUMS"}>{t.checksums} <ArrowDown size={15} aria-hidden="true" /></a>
      </section>
      <SdkGuide t={t} />
    </main>
    <footer className="footer">
      <div className="wrap footer-inner">
        <a className="brand" href="#"><img src={logo} width="32" height="32" alt="" />{t.name}</a>
        <div><a href="#sdk">{t.sdk}</a><a href={repo + (language === "en" ? "/blob/main/README.en.md" : "/blob/main/README.md")}>{t.docs}</a>
          <a href={repo + "/blob/main/LICENSE"}>Apache 2.0</a><a href={repo}>GitHub</a></div>
      </div>
    </footer>
  </>;
}

createRoot(document.getElementById("root")).render(<Website />);
