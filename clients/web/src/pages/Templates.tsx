import { useId, useState } from "react";
import {
  EuiBadge, EuiBasicTable, EuiButton, EuiButtonEmpty, EuiFieldText, EuiFormRow, EuiSelect,
  EuiSwitch, EuiText, EuiTextArea,
} from "@elastic/eui";
import { segment, type Api, type NotificationTemplate } from "../api";
import { RowAction, Confirm, Drawer, Empty, Failure, More, PageTitle, Progress, Tags } from "../components/Common";
import { useT } from "../preferences";
import { useMutation, usePage } from "../resources";
import type { SendSession } from "../send-draft";
import { useTemplateName } from "../template-name";

type Editor = { mode: "create" } | { mode: "view" | "edit" | "copy"; template: NotificationTemplate };

export default function Templates({ api, session, navigate }: {
  api: Api; session: SendSession; navigate: (path: string) => void;
}) {
  const t = useT();
  const templateName = useTemplateName();
  const templates = usePage<NotificationTemplate>(api, "/templates");
  const [editor, setEditor] = useState<Editor>();
  const [removing, setRemoving] = useState<NotificationTemplate>();
  const remove = useMutation();
  function useTemplate(template: NotificationTemplate) {
    const { draft } = session.snapshot();
    session.edit({
      inbox: false,
      templateEnabled: true,
      templateId: template.id,
      templateVariables: draft.templateId === template.id ? draft.templateVariables : {},
    });
    navigate("/admin/send");
  }
  return <>
    <PageTitle title={t("通知模板")} description={t("保存常用的标题和正文，发送时只填写变量值。")}
      action={<EuiButton fill iconType="plusCircle" onClick={() => setEditor({ mode: "create" })}>{t("创建模板")}</EuiButton>} />
    <Failure message={templates.error} retry={templates.reload} />
    {templates.loading ? <Progress /> : templates.items.length ? <div className="data-surface">
      <EuiBasicTable<NotificationTemplate> rowHeader="name" tableCaption={t("通知模板")} items={templates.items} itemId="id" columns={[
        { field: "name", name: t("名称"), render: (_: string, template: NotificationTemplate) => templateName(template) },
        { name: t("可见范围"), render: (template: NotificationTemplate) => <EuiBadge color={template.builtin ? "default" : template.shared ? "primary" : "default"}>
          {template.builtin ? t("内置") : template.shared ? t("共享") : t("仅自己")}
        </EuiBadge> },
        { field: "variables", name: t("变量"), render: (variables: string[]) => <Tags values={variables} /> },
        { name: t("操作"), render: (template: NotificationTemplate) => <div className="row-actions">
          <RowAction icon="plusInCircle" onClick={() => useTemplate(template)}>{t("使用模板")}</RowAction>
          <RowAction icon={template.can_edit ? "pencil" : "inspect"} onClick={() => setEditor({ mode: template.can_edit ? "edit" : "view", template })}>
            {template.can_edit ? t("编辑模板") : t("查看")}
          </RowAction>
          {!template.can_edit && <RowAction icon="copy" onClick={() => setEditor({ mode: "copy", template })}>{t("复制并编辑")}</RowAction>}
          {template.can_edit && <RowAction icon="trash" danger onClick={() => {
            remove.clear();
            setRemoving(template);
          }}>{t("删除")}</RowAction>}
        </div> },
      ]} />
      <More next={templates.next} busy={templates.busy} load={() => void templates.loadMore()} />
    </div> : !templates.error && <Empty title={t("暂无通知模板")} />}
    {editor && <TemplateEditor api={api} editor={editor} close={() => setEditor(undefined)} onDone={() => {
      setEditor(undefined);
      templates.reload();
    }} />}
    {removing && <Confirm title={t("删除模板「{name}」？", { name: templateName(removing) })} label={t("删除模板")}
      busy={remove.busy} close={() => setRemoving(undefined)} confirm={() => void remove.run(async () => {
        await api.write(`/templates/${segment(removing.id)}`, "DELETE");
        setRemoving(undefined);
        templates.reload();
      })}>
      <p>{t("之后无法用来发送新通知，已提交的通知会继续投递。")}</p>
      <Failure message={remove.error} />
    </Confirm>}
  </>;
}

function TemplateEditor({ api, editor, close, onDone }: {
  api: Api; editor: Editor; close: () => void; onDone: () => void;
}) {
  const t = useT();
  const templateName = useTemplateName();
  const id = useId();
  const template = editor.mode === "create" ? undefined : editor.template;
  const readOnly = editor.mode === "view";
  const copying = editor.mode === "copy";
  const [name, setName] = useState(copying ? `${editor.template.name.replace(/^builtin\./, "").slice(0, 75)}.copy` : template?.name ?? "");
  const [title, setTitle] = useState(template?.title ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [format, setFormat] = useState<NotificationTemplate["format"]>(template?.format ?? "text");
  const [shared, setShared] = useState(!copying && (template?.shared ?? false));
  const task = useMutation();
  const heading = copying ? t("复制并编辑模板") : editor.mode === "edit" ? t("编辑模板") : template ? templateName(template) : t("创建模板");
  return <Drawer title={heading} close={close}
    footer={readOnly ? <EuiButton onClick={close}>{t("完成")}</EuiButton> : <>
      <EuiButtonEmpty onClick={close}>{t("取消")}</EuiButtonEmpty>
      <EuiButton type="submit" form={id} fill isLoading={task.busy}>{t("保存模板")}</EuiButton>
    </>}>
    <form id={id} className="stack" onSubmit={(event) => {
      event.preventDefault();
      if (readOnly) return;
      void task.run(async () => {
        const existing = editor.mode === "edit" ? editor.template.id : undefined;
        await api.write(existing ? `/templates/${segment(existing)}` : "/templates", existing ? "PUT" : "POST",
          { name, title, body, format, shared });
        onDone();
      });
    }}>
      <Failure message={task.error} />
      <EuiFormRow label={t("模板名称")} helpText={t("用于 API 调用，可使用字母、数字、点、下划线和连字符。")} fullWidth>
        <EuiFieldText readOnly={readOnly} required fullWidth value={name} maxLength={80}
          pattern="[A-Za-z0-9._\\-]{1,80}" onChange={(event) => setName(event.target.value)} />
      </EuiFormRow>
      <EuiText size="s" color="subdued"><p>{t("在标题或正文中用双花括号标记变量，例如 {{service}}。")}</p></EuiText>
      <EuiFormRow label={t("标题")} fullWidth><EuiFieldText readOnly={readOnly} fullWidth value={title} required={!body.trim()}
        maxLength={4096} onChange={(event) => setTitle(event.target.value)} /></EuiFormRow>
      <EuiFormRow label={t("消息格式")} fullWidth>
        <EuiSelect disabled={readOnly} fullWidth value={format} onChange={(event) => setFormat(event.target.value as NotificationTemplate["format"])}
          options={[{ value: "text", text: t("纯文本") }, { value: "markdown", text: "Markdown" }]} />
      </EuiFormRow>
      <EuiFormRow label={t("正文")} fullWidth><EuiTextArea readOnly={readOnly} fullWidth rows={6} value={body}
        maxLength={32768} onChange={(event) => setBody(event.target.value)} /></EuiFormRow>
      {readOnly ? <EuiFormRow label={t("变量")} fullWidth><Tags values={template?.variables} /></EuiFormRow> :
        <EuiFormRow label={t("可见范围")} helpText={t("共享模板可用于有发送权限的账号或 API 密钥。")} fullWidth>
          <EuiSwitch label={t("共享模板")} checked={shared} onChange={(event) => setShared(event.target.checked)} />
        </EuiFormRow>}
    </form>
  </Drawer>;
}
