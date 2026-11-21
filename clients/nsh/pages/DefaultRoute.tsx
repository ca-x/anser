import { t } from "nsh/i18n";
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
        <WorkspacePage title={t("common.default_routing")} back={props.onBack}>
          <ReadState
            loading={
              value.state() === "pending" || value.state() === "refreshing"
            }
            problem={value.error() ? messageFor(value.error()) : ""}
            empty
            emptyLabel={t("default_route.no_default_route_found")}
          />
          <Action
            label={t("default_route.reload")}
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
      title={t("common.default_routing")}
      back={props.onBack}
      footer={
        <View class="flex-row flex-wrap gap-2">
          <Action
            label={
              action.busy()
                ? t("common.saving")
                : t("default_route.save_default_routing")
            }
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
        title={t("default_route.default_targets")}
        emptyLabel={t("default_route.with_no_targets_specified_all_available")}
        allowOverrides
      />
      <If when={accounts.next()}>
        <Action
          label={t("common.load_more_accounts")}
          onPress={accounts.more}
          disabled={accounts.loading()}
        />
      </If>
      <Section title={t("common.routing_policy")}>
        <Panel>
          <StrategyEditor draft={strategy} />
        </Panel>
      </Section>
    </WorkspacePage>
  );
}
