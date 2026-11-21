#[cfg(any(
    feature = "bark",
    feature = "email",
    feature = "feishu",
    feature = "ntfy",
    feature = "serverchan",
    feature = "telegram",
    feature = "wechat-mp",
    feature = "wecom"
))]
macro_rules! channel {
    ($module:ident, $feature:literal, $name:literal, $plugin:ty) => {
        #[cfg(feature = $feature)]
        mod $module {
            use anser_core::{ChannelAccount, Message};
            use anser_plugin_api::{Capabilities, ChannelService, SendError, SendOutcome};
            use rutis::Ctx;
            use serde_json::Value;

            pub(super) struct Plugin;

            impl rutis::Plugin for Plugin {
                type Deps = ();

                async fn apply(&self, ctx: &Ctx, _: ()) -> rutis::Result {
                    ctx.provide(Service(<$plugin>::default()))?;
                    Ok(())
                }
            }

            struct Service($plugin);

            #[rutis::service(name = $name)]
            impl Service {
                pub fn id(&self) -> String {
                    self.0.id().into()
                }

                pub fn display_name(&self) -> String {
                    self.0.display_name().into()
                }

                pub fn config_schema(&self) -> Value {
                    self.0.config_schema()
                }

                pub fn capabilities(&self) -> Capabilities {
                    self.0.capabilities()
                }

                pub fn validate_config(&self, config: Value) -> Result<(), SendError> {
                    self.0.validate_config(&config)
                }

                pub async fn send(
                    &self,
                    account: ChannelAccount,
                    message: Message,
                ) -> Result<SendOutcome, SendError> {
                    self.0.send(&account, &message).await
                }
            }
        }
    };
}

#[cfg(feature = "bark")]
channel!(bark, "bark", "anser.channel.bark", anser_plugin_bark::Bark);
#[cfg(feature = "email")]
channel!(
    email,
    "email",
    "anser.channel.email",
    anser_plugin_email::Email
);
#[cfg(feature = "feishu")]
channel!(
    feishu,
    "feishu",
    "anser.channel.feishu",
    anser_plugin_feishu::Feishu
);
#[cfg(feature = "ntfy")]
channel!(ntfy, "ntfy", "anser.channel.ntfy", anser_plugin_ntfy::Ntfy);
#[cfg(feature = "serverchan")]
channel!(
    serverchan,
    "serverchan",
    "anser.channel.serverchan",
    anser_plugin_serverchan::Serverchan
);
#[cfg(feature = "telegram")]
channel!(
    telegram,
    "telegram",
    "anser.channel.telegram",
    anser_plugin_telegram::Telegram
);
#[cfg(feature = "wechat-mp")]
channel!(
    wechat_mp,
    "wechat-mp",
    "anser.channel.wechat-mp",
    anser_plugin_wechat_mp::WechatMp
);
#[cfg(feature = "wecom")]
channel!(
    wecom,
    "wecom",
    "anser.channel.wecom",
    anser_plugin_wecom::Wecom
);

pub(super) const CHANNELS: &[(&str, super::lifecycle::Factory)] = &[
    #[cfg(feature = "bark")]
    ("bark", |root| root.plugin(bark::Plugin)),
    #[cfg(feature = "email")]
    ("email", |root| root.plugin(email::Plugin)),
    #[cfg(feature = "feishu")]
    ("feishu", |root| root.plugin(feishu::Plugin)),
    #[cfg(all(unix, feature = "lazycat"))]
    ("lazycat", |root| root.plugin(super::lazycat::Plugin)),
    #[cfg(feature = "ntfy")]
    ("ntfy", |root| root.plugin(ntfy::Plugin)),
    #[cfg(feature = "serverchan")]
    ("serverchan", |root| root.plugin(serverchan::Plugin)),
    #[cfg(feature = "telegram")]
    ("telegram", |root| root.plugin(telegram::Plugin)),
    #[cfg(feature = "wechat-mp")]
    ("wechat-mp", |root| root.plugin(wechat_mp::Plugin)),
    #[cfg(feature = "wecom")]
    ("wecom", |root| root.plugin(wecom::Plugin)),
];
