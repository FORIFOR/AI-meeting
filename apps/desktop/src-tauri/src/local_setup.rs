use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex};
use tauri::{AppHandle, Manager, State};
#[derive(Default)]
pub struct LocalProcess(pub Mutex<Option<Child>>);
fn data(app: &AppHandle) -> Result<PathBuf,String> { app.path().app_data_dir().map(|p|p.join("local-ai")).map_err(|e|e.to_string()) }
fn bundle(app:&AppHandle)->Result<PathBuf,String>{
 let p=app.path().resource_dir().map_err(|e|e.to_string())?.join("local-runtime");
 if p.join("runtime.json").exists(){return Ok(p)}
 #[cfg(debug_assertions)] { return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/local-runtime")); }
 #[cfg(not(debug_assertions))] { Err("ローカル実行環境がありません。最新版をインストールしてください。".into()) }
}
fn number(cmd:&str,args:&[&str])->u64 {Command::new(cmd).args(args).output().ok().and_then(|o|String::from_utf8(o.stdout).ok()).and_then(|s|s.trim().parse().ok()).unwrap_or(0)}
#[tauri::command]
pub fn local_setup_status(app:AppHandle,process:State<'_,LocalProcess>)->Result<Value,String>{
 let root=data(&app)?;fs::create_dir_all(&root).map_err(|e|e.to_string())?;
 let mut guard=process.0.lock().map_err(|_|"状態を取得できません")?;
 let running=guard.as_mut().map(|c|c.try_wait().ok().flatten().is_none()).unwrap_or(false);
 let mut status:Value=fs::read(root.join("status.json")).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or(json!({"phase":"idle","message":"初回セットアップが必要です"}));
 if !running && status["phase"]!="error" {status["phase"]=json!("idle");status["message"]=json!("ローカルAIを開始できます");}
 let mem=number("/usr/sbin/sysctl",&["-n","hw.memsize"])/(1024*1024*1024);
 let free=Command::new("/bin/df").args(["-Pk"]).arg(&root).output().ok().and_then(|o|String::from_utf8(o.stdout).ok()).and_then(|s|s.lines().last().and_then(|l|l.split_whitespace().nth(3)).and_then(|x|x.parse::<u64>().ok())).unwrap_or(0)*1024;
 status["memoryGB"]=json!(mem);status["freeBytes"]=json!(free);status["supported"]=json!(cfg!(target_os="macos")&&mem>=8);
 status["recommended"]=json!(if mem>=24 {"standard"} else {"lite"});
 status["installed"]=json!(root.join("installed.json").exists());
 status["installedProfile"]=fs::read(root.join("installed.json")).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()).map(|v|v["profile"].clone()).unwrap_or(Value::Null);status["bundled"]=json!(bundle(&app).map(|p|p.join("runtime.json").exists()).unwrap_or(false));
 status["running"]=json!(running);Ok(status)
}
pub fn launch(app:&AppHandle,process:&LocalProcess,action:&str,profile:&str)->Result<(),String>{
 if !cfg!(target_os="macos"){return Err("現在はMac版に対応しています。".into())}
 if !["install","start"].contains(&action)||!["lite","standard"].contains(&profile){return Err("不正な操作です".into())}
 let mut g=process.0.lock().map_err(|_|"実行中です")?;
 if let Some(c)=g.as_mut(){if c.try_wait().map_err(|e|e.to_string())?.is_none(){return Err("セットアップまたはローカルAIが実行中です。".into())}}
 let root=data(app)?;fs::create_dir_all(&root).map_err(|e|e.to_string())?;let b=bundle(app)?;
 let runtime:Value=serde_json::from_slice(&fs::read(b.join("runtime.json")).map_err(|_|"実行環境が未同梱です")?).map_err(|e|e.to_string())?;
 let node=runtime["node"].as_str().ok_or("実行環境が不正です")?;
 fs::write(root.join("status.json"),r#"{"phase":"checking","message":"環境を確認しています"}"#).map_err(|e|e.to_string())?;
 *g=Some(Command::new(b.join(node)).arg(b.join("setup.mjs")).arg(root).arg(action).arg(profile).arg(std::process::id().to_string()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e|format!("起動できません: {e}"))?);Ok(())
}
#[tauri::command]
pub fn local_setup_run(app:AppHandle,process:State<'_,LocalProcess>,action:String,profile:String)->Result<(),String>{
 let status=local_setup_status(app.clone(),process.clone())?;
 if status["supported"]!=true{return Err("8GB以上のメモリを搭載したMacが必要です。".into())}
 if profile=="standard" && status["memoryGB"].as_u64().unwrap_or(0)<24{return Err("標準モデルには24GB以上のメモリが必要です。軽量モデルを選んでください。".into())}
 if action=="install" {let required=if profile=="standard"{6_000_000_000u64}else{2_500_000_000};if status["freeBytes"].as_u64().unwrap_or(0)<required{return Err("空き容量が不足しています。不要なファイルを整理してください。".into())}}
 launch(&app,&process,&action,&profile)
}
pub fn stop(process:&LocalProcess){if let Ok(mut g)=process.0.lock(){if let Some(mut child)=g.take(){if child.try_wait().ok().flatten().is_some(){return;}let _=Command::new("/bin/kill").args(["-TERM",&child.id().to_string()]).status();let _=child.wait();}}}
#[tauri::command]
pub async fn local_setup_stop(app:AppHandle)->Result<(),String>{tauri::async_runtime::spawn_blocking(move||stop(&app.state::<LocalProcess>())).await.map_err(|e|e.to_string())?;Ok(())}
pub fn auto_start(app:&AppHandle){if let Ok(root)=data(app){if let Ok(bytes)=fs::read(root.join("installed.json")){if let Ok(v)=serde_json::from_slice::<Value>(&bytes){let _=launch(app,&app.state::<LocalProcess>(),"start",v["profile"].as_str().unwrap_or("lite"));}}}}
