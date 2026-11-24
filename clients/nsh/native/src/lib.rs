mod audio;
mod tray;

use nsh_core::prelude::*;

#[native_module("anser-native")]
fn native(registry: &mut Registry) {
    registry.module::<SystemTheme>();
    registry.class::<audio::LinuxAudio>();
    registry.module::<tray::DesktopTray>();
}

#[module]
/// Platform theme integration for the NSH client.
struct SystemTheme;

#[module]
impl SystemTheme {
    /// Checks whether the Linux user's current Omarchy palette can be loaded.
    pub fn omarchy_available() -> bool {
        cfg!(target_os = "linux") && nsh_omarchy::Theme::load_system().is_ok()
    }

    /// Applies the current Omarchy palette and follows desktop theme changes.
    pub fn follow_omarchy(_cx: &mut ModuleCx) {
        if cfg!(target_os = "linux") {
            nsh_omarchy::follow_system();
        }
    }

    /// Stops the theme watcher when the user selects another appearance.
    pub fn stop_following_omarchy(_cx: &mut ModuleCx) {
        nsh_omarchy::stop_following();
    }
}
