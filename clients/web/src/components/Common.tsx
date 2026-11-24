import { useLanguage, useT } from "../preferences";
import type { MouseEventHandler, ReactNode } from "react";
import {
  EuiBadge, EuiButton, EuiButtonEmpty, EuiButtonIcon, EuiCallOut, EuiConfirmModal, EuiEmptyPrompt,
  EuiFlyout, EuiFlyoutBody, EuiFlyoutFooter, EuiFlyoutHeader, EuiFormRow, EuiLoadingSpinner,
  EuiText, EuiTextArea, EuiTitle, EuiToolTip, type IconType,
} from "@elastic/eui";
import { useId, useMemo } from "react";
import type { JsonObject } from "../api";

export function PageTitle({ title, action, description }: { title: string; action?: ReactNode; description?: string }) {
  return <header className="page-title">
    <div>
      <h1>{title}</h1>
      {description && <EuiText color="subdued" size="s"><p>{description}</p></EuiText>}
    </div>
    {action && <div className="page-actions">{action}</div>}
  </header>;
}

export function RowAction({ icon, children, onClick, disabled, danger, href, label }: {
  icon: IconType; children: string; onClick?: MouseEventHandler<HTMLElement>; disabled?: boolean; danger?: boolean;
  href?: string; label?: string;
}) {
  const button = { "aria-label": label ?? children, onClick };
  const iconButton = { ...button, iconType: icon, size: "s", color: danger ? "danger" : "text" } as const;
  return <>
    <span className="row-action-desktop"><EuiToolTip content={children}>
      {href ? <EuiButtonIcon {...iconButton} href={href} /> : <EuiButtonIcon {...iconButton} disabled={disabled} />}
    </EuiToolTip></span>
    <span className="row-action-mobile"><EuiButtonEmpty {...button} size="xs" color={danger ? "danger" : "text"}
      href={href} disabled={disabled}>{children}</EuiButtonEmpty></span>
  </>;
}

export function Failure({ message, retry }: { message?: string; retry?: () => void }) {
  const t = useT();
  return message ? <EuiCallOut announceOnMount color="danger" iconType="warning" title={t(message)} size="s">
    {retry && <EuiButtonEmpty size="xs" onClick={retry}>{t("重新加载")}</EuiButtonEmpty>}
  </EuiCallOut> : null;
}

export function Progress({ label }: { label?: string }) {
  const t = useT();
  return <div className="loading" role="status"><EuiLoadingSpinner size="m" /><span>{label ?? t("正在加载")}</span></div>;
}

export function Empty({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <EuiEmptyPrompt className="data-empty" iconType="listBullet" title={<h2>{title}</h2>} body={description && <p>{description}</p>} actions={action} />;
}

export function More({ next, busy, load }: { next?: string | null; busy?: boolean; load: () => void }) {
  const t = useT();
  return next ? <div className="list-footer"><EuiButton size="s" isLoading={busy} onClick={load}>{t("加载更多")}</EuiButton></div> : null;
}

const states: Record<string, { label: string; color: "default" | "success" | "warning" | "danger" | "primary" }> = {
  pending: { label: "待发送", color: "default" },
  queued: { label: "已入队", color: "default" },
  sending: { label: "发送中", color: "primary" },
  waiting: { label: "等待重试", color: "warning" },
  success: { label: "成功", color: "success" },
  failed: { label: "失败", color: "danger" },
  dead: { label: "死信", color: "danger" },
  cancelled: { label: "已取消", color: "default" },
  skipped: { label: "已跳过", color: "default" },
};

export function Status({ value }: { value: string }) {
  const t = useT();
  const state = states[value];
  return <EuiBadge color={state?.color ?? "default"}>{state ? t(state.label) : value}</EuiBadge>;
}

export function useDate() {
  const language = useLanguage();
  const formatter = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }), [language]);
  return (value?: number | null) => value == null ? "—" : formatter.format(value);
}

export function Tags({ values }: { values?: string[] }) {
  return values?.length ? <span className="tags">{values.map((value) => <EuiBadge key={value}>{value}</EuiBadge>)}</span> : <span className="muted">—</span>;
}

export { split } from "../form-values";

export function object(value: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("JSON 格式无效。"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请输入 JSON 对象。");
  return parsed as JsonObject;
}

export function JsonInput({ label, value, set, help }: { label: string; value: string; set: (value: string) => void; help?: string }) {
  return <EuiFormRow label={label} helpText={help} fullWidth>
    <EuiTextArea className="code-input" rows={4} spellCheck={false} value={value} onChange={(event) => set(event.target.value)} fullWidth />
  </EuiFormRow>;
}

export function Drawer({ title, close, children, footer, size = "m" }: {
  title: string; close: () => void; children: ReactNode; footer?: ReactNode; size?: "s" | "m" | "l";
}) {
  const id = useId();
  return <EuiFlyout className="console-form-flyout" onClose={close} ownFocus size={size} aria-labelledby={id}>
    <EuiFlyoutHeader hasBorder><EuiTitle size="m"><h2 id={id}>{title}</h2></EuiTitle></EuiFlyoutHeader>
    <EuiFlyoutBody>{children}</EuiFlyoutBody>
    {footer && <EuiFlyoutFooter><div className="drawer-footer">{footer}</div></EuiFlyoutFooter>}
  </EuiFlyout>;
}

export function Confirm({ title, children, label, close, confirm, busy }: {
  title: string; children: ReactNode; label: string; close: () => void; confirm: () => void; busy?: boolean;
}) {
  const t = useT();
  return <EuiConfirmModal
    title={title} onCancel={close} onConfirm={confirm} cancelButtonText={t("取消")}
    confirmButtonText={label} buttonColor="danger" isLoading={busy} defaultFocusedButton="cancel"
  >{children}</EuiConfirmModal>;
}
