import { cleanup, effect, Scroll, signal, Text, View } from "nsh";
import { AnserApi } from "../api";
import type { Channel, User } from "../contracts";
import type { Pairing } from "../pairing";
import { parsePairing } from "../pairing";
import {
  Action,
  Choice,
  confirm,
  Field,
  Hint,
  Panel,
  Problem,
} from "../components/Controls";
import { Brand } from "../components/Workspace";
import { operation } from "../state";

export function Connection(props: {
  pairing?: Pairing;
  linkError?: string;
  onConnect: (api: AnserApi, channels: Channel[], user?: User) => void;
}) {
  const address = signal("");
  const method = signal("password");
  const username = signal("");
  const key = signal("");
  const password = signal("");
  const link = signal("");
  const pair = signal<Pairing | undefined>(undefined);
  const showImport = signal(false);
  const connect = operation();
  let pending: AnserApi | undefined;
  cleanup(() => pending?.close());
  effect(() => {
    const imported = props.pairing;
    if (imported) usePairing(imported);
  });

  function usePairing(imported: Pairing) {
    address.set(imported.origin);
    pair.set(imported.code ? imported : undefined);
    link.set("");
    showImport.set(false);
  }

  function submit(withCode = false) {
    void connect.run(async () => {
      const invitation = pair();
      if (withCode && !invitation?.code) return;
      if (
        withCode &&
        invitation &&
        !(await confirm(
          "使用配对码连接？",
          invitation.origin,
          "连接此服务器",
          false,
        ))
      )
        return;

      let user: User | undefined;
      let api: AnserApi;
      if ((withCode && invitation?.code) || method() === "password") {
        const publicApi = new AnserApi(
          withCode ? invitation!.origin : address(),
          undefined,
        );
        pending = publicApi;
        const signed = await (
          withCode && invitation?.code
            ? publicApi.exchange(invitation.code)
            : publicApi.login(username().trim(), password())
        ).finally(() => {
          publicApi.close();
          if (pending === publicApi) pending = undefined;
        });
        if (!connect.live()) return;
        user = signed.user;
        api = new AnserApi(publicApi.origin, signed.token);
      } else {
        api = new AnserApi(address(), key());
      }
      pending = api;
      try {
        const channels = await api.channels();
        if (!user) user = await api.me().catch(() => undefined);
        if (!connect.live()) return;
        pending = undefined;
        password.set("");
        key.set("");
        pair.set(undefined);
        props.onConnect(api, channels, user);
      } finally {
        if (pending === api) {
          pending = undefined;
          api.close();
        }
      }
    });
  }

  function importLink() {
    void connect.run(async () => usePairing(parsePairing(link())));
  }

  return (
    <Scroll class="flex-1 bg-background" keyboardDismissMode="on-drag">
      <View class="w-full max-w-lg self-center gap-6 px-5 pt-12 pb-10 md:pt-20">
        <Brand />
        <Panel>
          <Text role="header" class="text-[22px] font-semibold text-foreground">
            连接 Anser 服务器
          </Text>
          <Problem message={connect.problem() || props.linkError || ""} />
          <Field
            label="服务器地址"
            keyboard="url"
            value={address()}
            onChange={(value) => {
              address.set(value);
              pair.set(undefined);
            }}
            placeholder="https://anser.example.com"
            testID="server-address"
            disabled={connect.busy()}
          />
          <If
            when={pair()?.code}
            else={
              <View class="gap-3">
                <Choice
                  label="登录方式"
                  value={method()}
                  onChange={(value) => {
                    method.set(value ?? "password");
                    key.set("");
                    password.set("");
                  }}
                  items={[
                    { value: "password", title: "用户名和密码" },
                    { value: "key", title: "API Key" },
                  ]}
                  disabled={connect.busy()}
                />
                <If
                  when={method() === "password"}
                  else={
                    <Field
                      label="API Key"
                      value={key()}
                      onChange={key.set}
                      onSubmit={() => submit()}
                      masked
                      placeholder="输入服务器分配的 API Key"
                      testID="api-key"
                      disabled={connect.busy()}
                    />
                  }
                >
                  <View class="gap-3">
                    <Field
                      label="用户名"
                      value={username()}
                      onChange={username.set}
                      testID="username"
                      disabled={connect.busy()}
                    />
                    <Field
                      label="密码"
                      value={password()}
                      onChange={password.set}
                      onSubmit={() => submit()}
                      masked
                      testID="password"
                      disabled={connect.busy()}
                    />
                  </View>
                </If>
                <Hint>登录凭据仅用于本次连接。</Hint>
                <Action
                  label={connect.busy() ? "正在连接…" : "连接"}
                  kind="primary"
                  onPress={() => submit()}
                  disabled={
                    connect.busy() ||
                    !address().trim() ||
                    (method() === "key"
                      ? !key().trim()
                      : !username().trim() || !password())
                  }
                />
              </View>
            }
          >
            <View class="gap-3">
              <Hint>确认你信任此服务器。配对码只能使用一次。</Hint>
              <Action
                label="使用配对码连接"
                kind="primary"
                onPress={() => submit(true)}
                disabled={connect.busy()}
              />
              <Action
                label="改用其他登录方式"
                kind="quiet"
                onPress={() => pair.set(undefined)}
                disabled={connect.busy()}
              />
            </View>
          </If>
        </Panel>
        <Action
          label={showImport() ? "收起连接链接" : "导入连接链接"}
          kind="quiet"
          class="self-start"
          onPress={() => showImport.update((value) => !value)}
          disabled={connect.busy()}
        />
        <If when={showImport()}>
          <Panel>
            <Hint>
              用系统相机扫描服务器的二维码，或粘贴扫码后得到的连接链接。
            </Hint>
            <Field
              label="连接链接"
              value={link()}
              onChange={link.set}
              onSubmit={importLink}
              placeholder="anser://connect?server=…"
              masked
            />
            <Action
              label="预览服务器"
              onPress={importLink}
              disabled={!link().trim()}
            />
          </Panel>
        </If>
      </View>
    </Scroll>
  );
}
