fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["notify", "check_for_updates", "set_language"]),
    )).expect("building desktop permissions");
}
