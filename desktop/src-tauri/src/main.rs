mod hub;

use hub::{Hub, Log};
use std::{sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem}, tray::TrayIconBuilder, AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

struct Desktop {
    hub: Hub,
    log: Log,
    quitting: AtomicBool,
    stopped: AtomicBool,
    assume_update_yes: bool,
    updating: AtomicBool,
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        if window.set_focus().is_ok() {
            if let Some(desktop) = app.try_state::<Desktop>() { desktop.log.write("window focused"); }
        }
    }
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|error| error.to_string())
}

async fn stop_hub(app: &AppHandle) {
    let handle = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let desktop = handle.state::<Desktop>();
        desktop.hub.stop();
        desktop.stopped.store(true, Ordering::SeqCst);
    }).await;
}

fn quit(app: &AppHandle) {
    if app.state::<Desktop>().quitting.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        stop_hub(&app).await;
        app.exit(0);
    });
}

async fn update(app: &AppHandle, interactive: bool) -> Result<(), String> {
    let desktop = app.state::<Desktop>();
    if desktop.quitting.load(Ordering::SeqCst) || desktop.updating.swap(true, Ordering::SeqCst) { return Ok(()); }
    desktop.log.write("checking for updates");
    let result = async {
        let update = app.updater().map_err(|error| error.to_string())?
            .check().await.map_err(|error| error.to_string())?;
        let Some(update) = update else {
            desktop.log.write("app is up to date");
            if interactive {
                app.dialog().message("You’re running the latest version of omp-home.")
                    .title("omp-home updates").show(|_| {});
            }
            return Ok::<(), String>(());
        };
        desktop.log.write(format!("update available {}", update.version));
        if !desktop.assume_update_yes {
            let (answer, accepted) = tokio::sync::oneshot::channel();
            app.dialog().message(format!("omp-home {} is available. Install it and restart?\n\n{}", update.version, update.body.as_deref().unwrap_or("")))
                .title("Update omp-home")
                .buttons(MessageDialogButtons::OkCancelCustom("Install and restart".into(), "Later".into()))
                .show(move |yes| { let _ = answer.send(yes); });
            if !accepted.await.unwrap_or(false) { return Ok(()); }
        }
        desktop.log.write(format!("installing update {}", update.version));
        update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
        desktop.log.write(format!("installed update {}; restarting", update.version));
        desktop.quitting.store(true, Ordering::SeqCst);
        stop_hub(app).await;
        app.restart();
    }.await;
    desktop.updating.store(false, Ordering::SeqCst);
    if let Err(error) = &result {
        desktop.log.write(format!("update failed: {error}"));
        if interactive {
            app.dialog().message(format!("Could not update omp-home.\n\n{error}"))
                .title("Update failed").kind(MessageDialogKind::Error).show(|_| {});
        }
    }
    result
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<(), String> { update(&app, true).await }

fn main() {
    let log = Log::open().expect("open ~/Library/Logs/omp-home/desktop.log");
    let startup_log = log.clone();
    let panic_log = log.clone();
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |information| {
        panic_log.write(format!("desktop panic: {information}"));
        default_panic(information);
    }));
    let assume_update_yes = std::env::var("OMP_HOME_UPDATE_ASSUME_YES").as_deref() == Ok("1");
    let update_delay = std::env::var("OMP_HOME_UPDATE_CHECK_DELAY_SECS")
        .ok().and_then(|value| value.parse::<u64>().ok()).unwrap_or(15);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![notify, check_for_updates])
        .setup(move |app| {
            startup_log.write(format!("desktop launch version={} pid={}", app.package_info().version, std::process::id()));
            let open = MenuItem::with_id(app, "open", "Open omp-home", true, None::<&str>)?;
            let updates = MenuItem::with_id(app, "updates", "Check for updates…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit omp-home", true, Some("CmdOrCtrl+Q"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &updates, &separator, &quit_item])?;
            TrayIconBuilder::new().tooltip("omp-home")
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true).menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "updates" => { let app = app.clone(); tauri::async_runtime::spawn(async move { let _ = update(&app, true).await; }); }
                    "quit" => quit(app),
                    _ => {}
                }).build(app)?;
            startup_log.write("tray ready: Open omp-home; Check for updates; Quit omp-home");
            let hub = Hub::start(app.handle().clone(), startup_log.clone())?;
            app.manage(Desktop { hub, log: startup_log.clone(), quitting: AtomicBool::new(false), stopped: AtomicBool::new(false), updating: AtomicBool::new(false), assume_update_yes });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(update_delay)).await;
                loop {
                    let _ = update(&handle, false).await;
                    tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
                }
            });
            let handle = app.handle().clone();
            let mut signals = signal_hook::iterator::Signals::new([libc::SIGTERM, libc::SIGINT])?;
            std::thread::spawn(move || { if signals.forever().next().is_some() { quit(&handle); } });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(desktop) = webview.try_state::<Desktop>() {
                    let title = webview.get_webview_window("main").and_then(|window| window.title().ok()).unwrap_or_default();
                    desktop.log.write(format!("window loaded title={title:?} url={}", payload.url()));
                }
            }
        })
        .build(tauri::generate_context!()).expect("build omp-home desktop app");
    app.run(move |app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if !app.state::<Desktop>().stopped.load(Ordering::SeqCst) {
                api.prevent_exit();
                quit(app);
            }
        }
        RunEvent::Reopen { .. } => show(app),
        // A macOS "quit" Apple event (Dock, ⌘Q from the app menu, logout) can terminate the
        // application without ExitRequested; stop the owned hub here so omp children never outlive the app.
        RunEvent::Exit => {
            let desktop = app.state::<Desktop>();
            if !desktop.stopped.swap(true, Ordering::SeqCst) {
                log.write("exit without the quit path; stopping owned hub");
                desktop.hub.stop();
            }
            log.write("desktop exit");
        }
        _ => {}
    });
}
