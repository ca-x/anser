//! Rutis registration and invocation for on-demand plugins.

use anser_core::Message;
use anser_plugin_api::{ConfigOption, PluginDescriptor, PluginKind, TaskOutput, TransformOutput};
use rutis::Ctx;
use rutis_bridge::session::call_service;
use serde_json::Value;

use super::{HostError, channel_error};
use crate::lifecycle::{Factory, Lifecycle};

#[cfg(any(
    test,
    feature = "certificate-expiration",
    feature = "openai-tts",
    feature = "weather-wttr",
    feature = "weather-open-meteo"
))]
macro_rules! action_plugin {
    ($module:ident, $name:literal, $plugin:ty, $contract:ident, $method:ident, $input:ty, $output:ty) => {
        mod $module {
            use anser_plugin_api::{PluginDescriptor, PluginError, $contract};
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
                pub fn descriptor(&self) -> PluginDescriptor {
                    self.0.descriptor()
                }

                pub async fn $method(
                    &self,
                    config: Value,
                    input: $input,
                ) -> Result<$output, PluginError> {
                    action_plugin!(@call self.0, $method, config, input).await
                }

                pub fn validate_settings(&self, config: Value) -> Result<(), PluginError> {
                    action_plugin!(@validate self.0, $method, config)
                }

                pub async fn config_options(
                    &self, field: String, config: Value,
                ) -> Result<Vec<anser_plugin_api::ConfigOption>, PluginError> {
                    action_plugin!(@options self.0, $method, field, config)
                }
            }
        }
    };
    (@call $plugin:expr, run, $config:ident, $input:ident) => {
        $plugin.run(&$config, &$input)
    };
    (@call $plugin:expr, transform, $config:ident, $input:ident) => {
        $plugin.transform(&$config, $input)
    };
    (@validate $plugin:expr, transform, $config:ident) => {
        $plugin.validate_settings(&$config)
    };
    (@validate $plugin:expr, run, $config:ident) => {{
        let _ = $config;
        Err(PluginError::new("unsupported_plugin_settings", "This plugin does not provide these settings", false))
    }};
    (@options $plugin:expr, transform, $field:ident, $config:ident) => {
        $plugin.config_options(&$field, &$config).await
    };
    (@options $plugin:expr, run, $field:ident, $config:ident) => {{
        let _ = ($field, $config);
        Err(PluginError::new("unsupported_plugin_settings", "This plugin does not provide these settings", false))
    }};
}

#[cfg(feature = "certificate-expiration")]
action_plugin!(
    certificate_expiration,
    "anser.task.certificate-expiration",
    anser_plugin_certificate_expiration::CertificateExpiration,
    TaskService,
    run,
    Value,
    anser_plugin_api::TaskOutput
);
#[cfg(test)]
action_plugin!(
    text_affix,
    "anser.content_transform.text-affix",
    super::tests::TextAffix,
    ContentTransformService,
    transform,
    anser_core::Message,
    anser_plugin_api::TransformOutput
);

#[cfg(feature = "openai-tts")]
action_plugin!(
    openai_tts,
    "anser.content_transform.openai-tts",
    anser_plugin_openai_tts::OpenAiTts,
    ContentTransformService,
    transform,
    anser_core::Message,
    anser_plugin_api::TransformOutput
);

#[cfg(feature = "weather-wttr")]
action_plugin!(
    wttr_weather,
    "anser.task.wttr-weather",
    anser_plugin_weather_wttr::WttrWeather,
    TaskService,
    run,
    Value,
    anser_plugin_api::TaskOutput
);

#[cfg(feature = "weather-open-meteo")]
action_plugin!(
    open_meteo_weather,
    "anser.task.open-meteo-weather",
    anser_plugin_weather_open_meteo::OpenMeteoWeather,
    TaskService,
    run,
    Value,
    anser_plugin_api::TaskOutput
);

struct Registration {
    kind: PluginKind,
    id: &'static str,
    factory: Factory,
}

const BUILT_INS: &[Registration] = &[
    #[cfg(feature = "certificate-expiration")]
    Registration {
        kind: PluginKind::Task,
        id: "certificate-expiration",
        factory: |root| root.plugin(certificate_expiration::Plugin),
    },
    #[cfg(feature = "weather-wttr")]
    Registration {
        kind: PluginKind::Task,
        id: "wttr-weather",
        factory: |root| root.plugin(wttr_weather::Plugin),
    },
    #[cfg(feature = "weather-open-meteo")]
    Registration {
        kind: PluginKind::Task,
        id: "open-meteo-weather",
        factory: |root| root.plugin(open_meteo_weather::Plugin),
    },
    #[cfg(test)]
    Registration {
        kind: PluginKind::ContentTransform,
        id: "text-affix",
        factory: |root| root.plugin(text_affix::Plugin),
    },
    #[cfg(feature = "openai-tts")]
    Registration {
        kind: PluginKind::ContentTransform,
        id: "openai-tts",
        factory: |root| root.plugin(openai_tts::Plugin),
    },
];

pub(super) struct Action {
    pub descriptor: PluginDescriptor,
    lifecycle: Lifecycle,
    service: String,
}

impl Action {
    pub fn available(&self) -> bool {
        self.lifecycle.admit().is_ok()
    }
}

pub(super) struct Actions(Vec<Action>);

impl Actions {
    pub async fn mount(root: &Ctx) -> Result<Self, HostError> {
        let mut actions = Vec::with_capacity(BUILT_INS.len());
        for registration in BUILT_INS {
            let Registration { kind, id, factory } = *registration;
            let lifecycle = Lifecycle::mount(root, factory)
                .await
                .map_err(|_| HostError::Startup)?;
            let service = format!("anser.{}.{id}", kind.as_str());
            let descriptor: PluginDescriptor = call_service(root, &service, "descriptor", ())
                .await
                .map_err(HostError::Call)?;
            if descriptor.kind != kind || descriptor.id != id {
                return Err(HostError::Startup);
            }
            actions.push(Action {
                descriptor,
                lifecycle,
                service,
            });
        }
        Ok(Self(actions))
    }

    pub fn installed(&self) -> &[Action] {
        &self.0
    }

    fn find(&self, kind: PluginKind, id: &str) -> Result<&Action, HostError> {
        self.0
            .iter()
            .find(|action| action.descriptor.kind == kind && action.descriptor.id == id)
            .ok_or(HostError::PluginNotFound)
    }

    pub async fn run(
        &self,
        root: &Ctx,
        id: &str,
        config: Value,
        input: Value,
    ) -> Result<TaskOutput, HostError> {
        let action = self.find(PluginKind::Task, id)?;
        let _admission = action.lifecycle.admit()?;
        call_service(root, &action.service, "run", (config, input))
            .await
            .map_err(channel_error)
    }

    pub async fn transform(
        &self,
        root: &Ctx,
        id: &str,
        config: Value,
        message: Message,
    ) -> Result<TransformOutput, HostError> {
        let action = self.find(PluginKind::ContentTransform, id)?;
        let _admission = action.lifecycle.admit()?;
        call_service(root, &action.service, "transform", (config, message))
            .await
            .map_err(channel_error)
    }

    pub async fn validate_transform_settings(
        &self,
        root: &Ctx,
        id: &str,
        config: &Value,
    ) -> Result<(), HostError> {
        let action = self.find(PluginKind::ContentTransform, id)?;
        let _admission = action.lifecycle.admit()?;
        call_service(root, &action.service, "validateSettings", (config,))
            .await
            .map_err(channel_error)
    }

    pub async fn transform_options(
        &self,
        root: &Ctx,
        id: &str,
        field: &str,
        config: &Value,
    ) -> Result<Vec<ConfigOption>, HostError> {
        let action = self.find(PluginKind::ContentTransform, id)?;
        let _admission = action.lifecycle.admit()?;
        call_service(root, &action.service, "configOptions", (field, config))
            .await
            .map_err(channel_error)
    }
}

#[cfg(test)]
mod tests {
    use anser_core::Message;
    use anser_plugin_api::{
        ContentTransformService, PluginDescriptor, PluginFuture, PluginKind, TransformOutput,
    };
    use serde_json::{Value, json};

    use crate::{ChannelHost, HostError};

    #[derive(Default)]
    pub(super) struct TextAffix;

    impl ContentTransformService for TextAffix {
        fn descriptor(&self) -> PluginDescriptor {
            PluginDescriptor {
                kind: PluginKind::ContentTransform,
                id: "text-affix".into(),
                display_name: "Title prefix fixture".into(),
                version: None,
                config_schema: json!({}),
            }
        }

        fn transform<'a>(
            &'a self,
            config: &'a Value,
            mut message: Message,
        ) -> PluginFuture<'a, TransformOutput> {
            Box::pin(async move {
                message
                    .title
                    .insert_str(0, config["title_prefix"].as_str().unwrap());
                Ok(TransformOutput {
                    message,
                    artifacts: Vec::new(),
                })
            })
        }
    }

    #[tokio::test]
    async fn dispatches_installed_plugins_by_capability() {
        let host = ChannelHost::start().await.unwrap();
        assert!(host.actions().any(|(plugin, available)| {
            available && plugin.kind == PluginKind::ContentTransform && plugin.id == "text-affix"
        }));
        let transformed = host
            .transform(
                "text-affix",
                json!({"title_prefix": "[Today] "}),
                Message {
                    title: "Check backup".into(),
                    ..Message::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(transformed.message.title, "[Today] Check backup");
        assert!(matches!(
            host.run_task("text-affix", json!({}), Value::Null).await,
            Err(HostError::PluginNotFound)
        ));
        #[cfg(feature = "certificate-expiration")]
        assert!(matches!(
            host.run_task("certificate-expiration", json!({"urls": ["http://example.invalid/"]}), Value::Null).await,
            Err(HostError::Send(error)) if error.code == "certificate_url"
        ));
        host.shutdown().await.unwrap();
    }
}
