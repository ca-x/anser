import { EuiFieldText, EuiFormRow, EuiSelect, EuiTextArea } from "@elastic/eui";
import type { Message } from "../api";

export const blankMessage: Message = { title: "", body: "", format: "text" };

export function Composer({ message, update }: { message: Message; update: (message: Message) => void }) {
  return <>
    <EuiFormRow label="标题" fullWidth>
      <EuiFieldText fullWidth value={message.title} required onChange={(event) => update({ ...message, title: event.target.value })} />
    </EuiFormRow>
    <EuiFormRow label="消息格式" fullWidth>
      <EuiSelect fullWidth value={message.format} onChange={(event) => update({ ...message, format: event.target.value as Message["format"] })}
        options={[{ value: "text", text: "纯文本" }, { value: "markdown", text: "Markdown" }, { value: "html", text: "HTML" }]} />
    </EuiFormRow>
    <EuiFormRow label="正文" fullWidth>
      <EuiTextArea fullWidth value={message.body} rows={6} onChange={(event) => update({ ...message, body: event.target.value })} />
    </EuiFormRow>
  </>;
}
