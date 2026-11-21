import { useT } from "../preferences";
import { EuiFieldText, EuiFormRow, EuiSelect, EuiTextArea } from "@elastic/eui";
import type { Message } from "../api";

export const blankMessage: Message = { title: "", body: "", format: "text" };

export function Composer({ message, update }: { message: Message; update: (message: Message) => void }) {
  const t = useT();
  return <>
    <EuiFormRow label={t("标题")} helpText={t("标题和正文至少填写一项。")} fullWidth>
      <EuiFieldText fullWidth value={message.title} required={!message.body.trim()} onChange={(event) => update({ ...message, title: event.target.value })} />
    </EuiFormRow>
    <EuiFormRow label={t("消息格式")} fullWidth>
      <EuiSelect fullWidth value={message.format} onChange={(event) => update({ ...message, format: event.target.value as Message["format"] })}
        options={[{ value: "text", text: t("纯文本") }, { value: "markdown", text: "Markdown" }, { value: "html", text: "HTML" }]} />
    </EuiFormRow>
    <EuiFormRow label={t("正文")} fullWidth>
      <EuiTextArea fullWidth value={message.body} rows={6} onChange={(event) => update({ ...message, body: event.target.value })} />
    </EuiFormRow>
  </>;
}
