use super::*;
use serde_json::{Value, json};
use std::time::Duration;

async fn node(script: &str, args: &[&Path]) -> Value {
    let mut command = tokio::process::Command::new("node");
    command.args(["--input-type=module", "-e", script]);
    for arg in args { command.arg(arg); }
    command.kill_on_drop(true);
    let output = mixdog_rt::time::timeout(Duration::from_secs(30), command.output()).await
        .expect("office startup fixture Node process did not exit within 30 seconds").unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn session_start_sweeps_the_complete_recorded_office_subject() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
    let recording = root.join("native/core/fixtures/office-startup/recording.json");
    let expected: Value = serde_json::from_str(include_str!("../../../../fixtures/office-startup/recording.json")).unwrap();
    let mut js = crate::js_runtime::fixture(dir.path());
    js.program = "node".into();
    let worker = js.package_root.join("src/ext-host/worker.mjs");
    let real_worker = root.join("src/ext-host/worker.mjs");
    let setup = r#"
      import {mkdir,readFile,writeFile,utimes} from 'node:fs/promises';
      import {dirname,join} from 'node:path';
      import {pathToFileURL} from 'node:url';
      const [data,fixture,worker,real]=process.argv.slice(1);
      const input=JSON.parse(await readFile(fixture,'utf8'));
      for(const row of input.inputs) {
        const path=join(data,row.path); await mkdir(dirname(path),{recursive:true});
        await writeFile(path,row.text); await utimes(path,row.mtimeMs/1000,row.mtimeMs/1000);
      }
      await mkdir(dirname(worker),{recursive:true});
      await writeFile(worker,`import {mock} from 'node:test';
        process.chdir(${JSON.stringify(data)});
        mock.timers.enable({apis:['Date','setTimeout','setInterval','setImmediate'],now:${input.now-1}});
        mock.timers.tick(1);
        await import(${JSON.stringify(pathToFileURL(real).href)});`);
      console.log('null');
    "#;
    node(setup, &[&data, &recording, &worker, &real_worker]).await;
    let tokens = mixdog_rt::testing::tokens();
    let stop = mixdog_rt::CancellationToken::new();
    let mut completed = crate::office_startup::completions().subscribe();
    let core = mixdog_rt::time::timeout(Duration::from_secs(60), compose(&tokens, ComposeConfig {
        data_dir: data.clone(), user_data_dir: dir.path().join("userdata"),
        js_runtime: js, ort_library: OrtRuntime::NoBinding,
        outgoing: mixdog_app_server::Outgoing::new(),
        ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
        log: crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone()),
        stop, catalog_http: crate::compose_test_support::offline_http(),
        pg_install: Some(Arc::new(|_| Box::pin(async {
            Err(mixdog_services::memory::error::MemoryError::Runtime("office sweep test must not install PostgreSQL".into()))
        }))),
    })).await.expect("office sweep core composition did not complete within 60 seconds").unwrap();
    let thread = mixdog_core_api::ids::ThreadId::from("office-startup-recording");
    let outcome = async {
        core.real.directory.create_with_id(thread.clone(), serde_json::Map::new(), json!({})).await.unwrap();
        mixdog_rt::time::timeout(Duration::from_secs(30), async {
            loop { if completed.recv().await.unwrap() == thread { break; } }
        }).await.expect("session startup office-journal host call did not complete within 30 seconds");
        let snapshot = r#"
          import {readFile,readdir} from 'node:fs/promises';
          import {join} from 'node:path';
          const [data,fixture]=process.argv.slice(1);
          const {inputs}=JSON.parse(await readFile(fixture,'utf8'));
          async function tree(dir,prefix='') {
            const out=[];
            for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
              const path=prefix+e.name;
              if(e.isDirectory()) out.push({path,kind:'directory'},...await tree(join(dir,e.name),path+'/'));
              else out.push({path,kind:'file',base64:(await readFile(join(dir,e.name))).toString('base64')});
            } return out;
          }
          const artifacts=[];
          for(const input of inputs) {
            if(!input.path.endsWith('.json')) continue;
            let record; try {record=JSON.parse(input.text);} catch {continue;}
            for(const path of [record.checkpoint,record.baselinePdf]) {
              try {artifacts.push({path,present:true,base64:(await readFile(join(data,path))).toString('base64')});}
              catch(e) {if(e.code!=='ENOENT')throw e; artifacts.push({path,present:false});}
            }
          }
          console.log(JSON.stringify({journals:await tree(join(data,'office-transactions')),artifacts}));
        "#;
        node(snapshot, &[&data, &recording]).await
    };
    use futures::FutureExt;
    let result = std::panic::AssertUnwindSafe(outcome).catch_unwind().await;
    mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("office startup test")).await
        .expect("office startup core shutdown did not complete within 30 seconds");
    assert_eq!(result.unwrap(), expected["tree"]);
}
