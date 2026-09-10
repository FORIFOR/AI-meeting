mod local_setup;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(local_setup::LocalProcess::default())
        .invoke_handler(tauri::generate_handler![local_setup::local_setup_status, local_setup::local_setup_run, local_setup::local_setup_stop])
        .setup(|app| { local_setup::auto_start(app.handle()); Ok(()) })
        .build(tauri::generate_context!())
        .expect("error while building rcai desktop")
        .run(|app,event| { if matches!(event,tauri::RunEvent::Exit) { use tauri::Manager; local_setup::stop(&app.state::<local_setup::LocalProcess>()); } });
}
