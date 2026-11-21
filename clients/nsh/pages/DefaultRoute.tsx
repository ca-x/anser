import { resource, signal, View } from "nsh";
import type { AnserApi } from "../api";
import { messageFor } from "../api";
import type { Channel, Policy, Target } from "../contracts";
import {
  Action,
  Panel,
  Problem,
  ReadState,
  Section,
} from "../components/Controls";
import { strategyDraft, StrategyEditor, Targets } from "../components/Routing";
import { WorkspacePage } from "../components/Workspace";
import { operation, paged } from "../state";

export function DefaultRoute(props: {
  api: AnserApi;
  channels: Channel[];
  onBack: () => void;
  onSaved: () => void;
}) {
  const value = resource(true, (_, { signal: abort }) =>
    props.api.defaultRoute(abort),
  );
  return (
    <If
      when={value()}
      else={
        <WorkspacePage title="默认路由" back={props.onBack}>
          <ReadState
            loading={
              value.state() === "pending" || value.state() === "refreshing"
            }
            problem={value.error() ? messageFor(value.error()) : ""}
            empty
            emptyLabel="未找到默认路由。"
          />
          <Action
            label="重新加载"
            onPress={value.refetch}
            disabled={value.state() === "pending"}
            class="self-start"
          />
        </WorkspacePage>
      }
    >
      {(initial) => (
        <DefaultRouteEditor
          api={props.api}
          channels={props.channels}
          initial={initial()}
          onBack={props.onBack}
          onSaved={props.onSaved}
        />
      )}
    </If>
  );
}

function DefaultRouteEditor(props: {
  api: AnserApi;
  channels: Channel[];
  initial: Policy;
  onBack: () => void;
  onSaved: () => void;
}) {
  const strategy = strategyDraft(props.initial);
  const targets = signal<Target[]>(props.initial.targets);
  const accounts = paged(props.api.accounts.bind(props.api));
  const action = operation();
  function save() {
    void action.run(async () => {
      const policy = strategy.value();
      await props.api.saveDefaultRoute({
        ...policy,
        mode: policy.mode ?? "broadcast",
        targets: targets(),
      });
      if (action.live()) props.onSaved();
    });
  }
  return (
    <WorkspacePage
      title="默认路由"
      back={props.onBack}
      footer={
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={action.busy() ? "正在保存…" : "保存默认路由"}
            onPress={save}
            kind="primary"
            disabled={action.busy()}
          />
        </View>
      }
    >
      <Problem message={action.problem()} />
      <Targets
        targets={targets()}
        onChange={targets.set}
        channels={props.channels}
        accounts={accounts.items()}
        title="默认目标"
        emptyLabel="未指定目标时匹配全部可用账号。"
        allowOverrides
      />
      <If when={accounts.next()}>
        <Action
          label="加载更多账号"
          onPress={accounts.more}
          disabled={accounts.loading()}
        />
      </If>
      <Section title="路由策略">
        <Panel>
          <StrategyEditor draft={strategy} />
        </Panel>
      </Section>
    </WorkspacePage>
  );
}
