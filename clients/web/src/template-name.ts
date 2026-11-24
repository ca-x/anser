import type { NotificationTemplate } from "./api";
import { useT } from "./preferences";

export function useTemplateName() {
  const t = useT();
  return (template: NotificationTemplate) => {
    if (template.id === "builtin.deployment") return t("部署完成");
    if (template.id === "builtin.service_alert") return t("服务告警");
    return template.name;
  };
}
