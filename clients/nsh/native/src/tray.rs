use nsh_core::prelude::*;

/// Desktop services that are optional at runtime.
#[module]
pub(crate) struct DesktopTray;

#[module]
impl DesktopTray {
    /// On Linux check that a StatusNotifier watcher has a registered panel.
    pub async fn host_available() -> bool {
        #[cfg(target_os = "linux")]
        {
            let (sender, receiver) = futures_channel::oneshot::channel();
            if std::thread::Builder::new()
                .name("anser-tray-probe".into())
                .spawn(move || {
                    let _ = sender.send(linux_host_available());
                })
                .is_ok()
            {
                return receiver.await.unwrap_or(false);
            }
            false
        }
        #[cfg(not(target_os = "linux"))]
        {
            true
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_host_available() -> bool {
    use gio::glib::{Variant, variant::ToVariant};

    const WATCHER: &str = "org.kde.StatusNotifierWatcher";
    let Ok(connection) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
        return false;
    };
    connection
        .call_sync(
            Some(WATCHER),
            "/StatusNotifierWatcher",
            "org.freedesktop.DBus.Properties",
            "Get",
            Some(&(WATCHER, "IsStatusNotifierHostRegistered").to_variant()),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            500,
            gio::Cancellable::NONE,
        )
        .ok()
        .and_then(|response| response.get::<(Variant,)>())
        .and_then(|(value,)| value.get::<bool>())
        .unwrap_or(false)
}
