import { EuiText } from "@elastic/eui";
import { pluginHelp, type ConfigSchema } from "../form-values";
import { useLanguage, useT } from "../preferences";

export function PluginHelp({ plugin }: { plugin: ConfigSchema }) {
  const t = useT();
  const help = pluginHelp(plugin, useLanguage());
  return help ? <section aria-label={t("使用说明")}>
    <EuiText size="s"><h3>{t("使用说明")}</h3><p className="plugin-result-text">{help}</p></EuiText>
  </section> : null;
}
