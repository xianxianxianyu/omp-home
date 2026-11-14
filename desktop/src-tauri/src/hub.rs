use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Url};

#[derive(Clone)]
pub struct Log(Arc<Mutex<File>>);

impl Log {
    pub fn open() -> std::io::Result<Self> {
        let directory = PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Logs/omp-home");
        fs::create_dir_all(&directory)?;
        let file = OpenOptions::new().append(true).create(true).mode(0o600)
            .open(directory.join("desktop.log"))?;
        Ok(Self(Arc::new(Mutex::new(file))))
    }

    pub fn write(&self, message: impl AsRef<str>) {
        let seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        if let Ok(mut file) = self.0.lock() {
            let _ = writeln!(file, "{seconds} {}", message.as_ref());
        }
    }
}

pub struct Hub {
    stop: mpsc::Sender<mpsc::SyncSender<()>>,
}

impl Hub {
    pub fn start(app: AppHandle, log: Log) -> std::io::Result<Self> {
        let resources = app.path().resource_dir().map_err(std::io::Error::other)?.join("hub");
        let executable = std::env::current_exe()?.with_file_name("node");
        let (stop, receiver) = mpsc::channel();
        thread::Builder::new().name("hub-supervisor".into()).spawn(move || {
            supervise(app, log, executable, resources, receiver);
        })?;
        Ok(Self { stop })
    }

    pub fn stop(&self) {
        let (done, receiver) = mpsc::sync_channel(0);
        if self.stop.send(done).is_ok() {
            let _ = receiver.recv_timeout(Duration::from_secs(11));
        }
    }
}

fn ready_url(line: &str, prefix: &str) -> Option<Url> {
    let url = Url::parse(line.strip_prefix(prefix)?).ok()?;
    (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some())
        .then_some(url)
}

fn navigate(app: &AppHandle, log: &Log, url: Url) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.navigate(url.clone()) {
            log.write(format!("window navigation failed: {error}"));
        } else {
            log.write(format!("window ready {url}"));
        }
    }
}

fn terminate(child: &mut Child, log: &Log) {
    let pid = child.id();
    log.write(format!("stopping owned hub pid={pid}"));
    // Only the supervisor owns/reaps this child, so its PID cannot be reused before wait.
    unsafe { libc::kill(pid as i32, libc::SIGTERM); }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => { log.write(format!("hub stopped pid={pid} status={status}")); return; }
            Err(error) => { log.write(format!("hub wait failed: {error}")); return; }
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            log.write(format!("hub shutdown timed out pid={pid}; killing"));
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn supervise(app: AppHandle, log: Log, executable: PathBuf, resources: PathBuf,
    stop: mpsc::Receiver<mpsc::SyncSender<()>>) {
    let mut delay = 1;
    loop {
        if let Ok(done) = stop.try_recv() { let _ = done.send(()); return; }
        let launched = Instant::now();
        let spawn = Command::new(&executable)
            .arg(resources.join("hub.mjs")).args(["--port", "0", "--no-open"])
            .env("OMP_HOME_RESOURCES", resources.join("resources"))
            .env("OMP_HOME_LOGIN_ENV", "1")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
        match spawn {
            Ok(mut child) => {
                log.write(format!("spawned hub pid={}", child.id()));
                let (lines, receiver) = mpsc::channel();
                if let Some(stdout) = child.stdout.take() {
                    let log = log.clone();
                    thread::spawn(move || {
                        for line in BufReader::new(stdout).lines() {
                            match line {
                                Ok(line) => { log.write(format!("hub stdout: {line}")); if lines.send(line).is_err() { break; } }
                                Err(error) => { log.write(format!("hub stdout failed: {error}")); break; }
                            }
                        }
                    });
                }
                if let Some(stderr) = child.stderr.take() {
                    let log = log.clone();
                    thread::spawn(move || {
                        for line in BufReader::new(stderr).lines() {
                            match line {
                                Ok(line) => log.write(format!("hub stderr: {line}")),
                                Err(error) => { log.write(format!("hub stderr failed: {error}")); break; }
                            }
                        }
                    });
                }
                let mut attached = None;
                loop {
                    if let Ok(done) = stop.try_recv() {
                        terminate(&mut child, &log);
                        let _ = done.send(());
                        return;
                    }
                    for line in receiver.try_iter() {
                        if let Some(url) = ready_url(&line, "omp-home ready ") { navigate(&app, &log, url); }
                        if let Some(url) = ready_url(&line, "omp-home already running ") { attached = Some(url); }
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            // Drain to EOF after exit: the stdout reader may not have delivered its last line yet.
                            for line in receiver.iter() {
                                if let Some(url) = ready_url(&line, "omp-home already running ") { attached = Some(url); }
                            }
                            if status.code() == Some(75) {
                                if let Some(url) = attached {
                                    log.write(format!("attached to existing hub {url}; not owned"));
                                    let address = std::net::SocketAddr::from(([127, 0, 0, 1], url.port().expect("validated hub port")));
                                    navigate(&app, &log, url);
                                    loop {
                                        match stop.recv_timeout(Duration::from_secs(1)) {
                                            Ok(done) => { let _ = done.send(()); return; }
                                            Err(mpsc::RecvTimeoutError::Disconnected) => return,
                                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                                if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_err() { break; }
                                            }
                                        }
                                    }
                                    log.write("attached hub disconnected; taking over if its lock is free");
                                    break;
                                }
                            }
                            log.write(format!("hub exited unexpectedly: {status}"));
                            break;
                        }
                        Err(error) => { log.write(format!("hub wait failed: {error}")); terminate(&mut child, &log); break; }
                        Ok(None) => {}
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
            Err(error) => log.write(format!("hub spawn failed: {error}")),
        }
        if launched.elapsed() > Duration::from_secs(60) { delay = 1; }
        log.write(format!("restarting hub in {delay}s"));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(Url::parse("tauri://localhost/index.html").expect("static loading URL"));
        }
        match stop.recv_timeout(Duration::from_secs(delay)) {
            Ok(done) => { let _ = done.send(()); return; }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        delay = (delay * 2).min(30);
    }
}
