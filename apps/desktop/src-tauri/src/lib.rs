//! Desktop shell: wraps the web app. Local services (token-broker / agent) are run
//! by `pnpm dev`; the shell only hosts the UI so vendor SDKs stay out of native code.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running rcai desktop");
}
