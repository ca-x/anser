use nsh_core::prelude::*;

#[cfg(target_os = "linux")]
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
};

#[cfg(target_os = "linux")]
const MAX_RECORDING_BYTES: usize = 4 * 1024 * 1024;
#[cfg(target_os = "linux")]
static GTK_MP3_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// A Linux voice playback session for desktops without a GTK MP3 decoder.
#[class]
pub(crate) struct LinuxAudio {
    #[cfg(target_os = "linux")]
    cancelled: Arc<AtomicBool>,
}

#[class]
impl LinuxAudio {
    /// Creates a stopped player.
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Whether GTK GStreamer's registry advertises an MP3-to-PCM decoder.
    pub async fn gtk_mp3_available() -> bool {
        #[cfg(target_os = "linux")]
        {
            if let Some(available) = GTK_MP3_AVAILABLE.get() {
                return *available;
            }
            let (sender, receiver) = futures_channel::oneshot::channel();
            if std::thread::Builder::new()
                .name("anser-mp3-probe".into())
                .spawn(move || {
                    let _ = sender.send(*GTK_MP3_AVAILABLE.get_or_init(gtk_mp3_available));
                })
                .is_ok()
            {
                return receiver.await.unwrap_or(true);
            }
        }
        true
    }

    /// Plays a bounded MP3 fetched by the client, resolving at the end.
    pub async fn play(
        this: Instance<Self>,
        bytes: Vec<u8>,
        started: Callback<()>,
    ) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            if bytes.is_empty() || bytes.len() > MAX_RECORDING_BYTES {
                return Err("Invalid speech recording size".into());
            }

            let cancelled = this.with(|player| Arc::clone(&player.cancelled));
            let (ready, playing) = futures_channel::oneshot::channel();
            let (finished, complete) = futures_channel::oneshot::channel();
            std::thread::Builder::new()
                .name("anser-speech".into())
                .spawn(move || {
                    let result = play_mp3(bytes, &cancelled, ready);
                    let _ = finished.send(result);
                })
                .map_err(|_| "Could not start the audio worker".to_owned())?;

            if playing.await.is_ok() {
                started.post(());
            }
            complete.await.map_err(|_| "The audio worker stopped")?
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (this, bytes, started);
            Err("Linux audio is unavailable".into())
        }
    }

    /// Stops pending or current playback.
    pub fn stop(&self) {
        #[cfg(target_os = "linux")]
        self.cancelled.store(true, Ordering::Release);
    }
}

#[cfg(target_os = "linux")]
impl Drop for LinuxAudio {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(target_os = "linux")]
fn gtk_mp3_available() -> bool {
    use gstreamer::{Caps, ElementFactory, ElementFactoryType, Rank};

    if gstreamer::init().is_err() {
        return false;
    }
    let mp3 = Caps::builder("audio/mpeg")
        .field("mpegversion", 1_i32)
        .field("layer", 3_i32)
        .build();
    let pcm = Caps::builder("audio/x-raw").build();
    ElementFactory::factories_with_type(ElementFactoryType::DECODER, Rank::MARGINAL)
        .iter()
        .any(|factory| factory.can_sink_any_caps(&mp3) && factory.can_src_any_caps(&pcm))
}

#[cfg(target_os = "linux")]
fn play_mp3(
    bytes: Vec<u8>,
    cancelled: &AtomicBool,
    ready: futures_channel::oneshot::Sender<()>,
) -> Result<(), String> {
    use std::{io::Cursor, thread, time::Duration};

    if cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    let source = rodio::Decoder::new_mp3(Cursor::new(bytes))
        .map_err(|_| "Could not decode the MP3 recording")?;
    let output = rodio::DeviceSinkBuilder::open_default_sink()
        .map_err(|_| "Could not open the default audio output")?;
    if cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    let player = rodio::Player::connect_new(output.mixer());
    player.append(source);
    let _ = ready.send(());
    while !player.empty() && !cancelled.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(40));
    }
    player.stop();
    Ok(())
}
