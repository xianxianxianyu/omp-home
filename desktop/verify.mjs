import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-home-desktop-')));
const config = path.join(scratch, 'config');
const home = path.join(scratch, 'home');
const installed = path.join(scratch, 'Applications/omp-home.app');
const bundle = path.join(root, 'desktop/src-tauri/target/release/bundle');
const logFile = path.join(homedir(), 'Library/Logs/omp-home/desktop.log');
const oldLogSize = await stat(logFile).then(info => info.size).catch(() => 0);
const evidence = [];
const running = new Set();
const processIds = new Set();
let updatePublished = false;
function record(message) { evidence.push(message); console.log(message); }
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${signal ?? code}`)));
  });
}
async function log() {
  try { return (await readFile(logFile)).subarray(oldLogSize).toString(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function until(check, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function descendants(parent) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
  }).filter(Boolean);
  const found = [];
  const parents = new Set([parent]);
  for (let index = 0; index < rows.length; index++) {
    for (const row of rows) if (parents.has(row.parent) && !parents.has(row.pid)) { parents.add(row.pid); found.push(row); }
  }
  return found;
}
async function launch(delay, expected = 'ready') {
  const offset = (await log()).length;
  const child = spawn(path.join(installed, 'Contents/MacOS/omp-home'), [], { env: {
    ...process.env, OMP_HOME_CONFIG_DIR: config, OMP_HOME_UPDATE_ASSUME_YES: '1', OMP_HOME_UPDATE_CHECK_DELAY_SECS: String(delay),
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  running.add(child.pid);
  child.on('exit', () => running.delete(child.pid));
  const text = await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`App exited before readiness: ${errors}`);
    const text = (await log()).slice(offset);
    return /window loaded title="omp-home" url=http:/.test(text) && text.includes(`omp-home ${expected} `) && text;
  }, 'app window and hub ready');
  assert.match(text, /tray ready: Open omp-home; Check for updates; Quit omp-home/);
  assert.match(text, /window loaded title="omp-home"/);
  const url = new URL(text.match(/omp-home (?:ready|already running) (http:\/\/\S+)/)[1]);
  const hubPid = Number(text.match(/spawned hub pid=(\d+)/)[1]);
  processIds.add(hubPid);
  record(`Launched app pid=${child.pid}, hub pid=${hubPid}, window title=omp-home, tray constructed`);
  return { child, url, hubPid };
}
async function api(url, route, body) {
  const token = url.searchParams.get('token') ?? new URLSearchParams(url.hash.slice(1)).get('token');
  const response = await fetch(new URL(route, url), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function quit(pid) {
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  await until(() => !alive(pid), `app ${pid} exits`, 15000);
  running.delete(pid);
}
const server = createServer(async (request, response) => {
  if (!updatePublished) { response.writeHead(204).end(); return; }
  const filename = request.url === '/latest.json' ? 'latest.json' : request.url === '/omp-home.app.tar.gz' ? 'omp-home.app.tar.gz' : null;
  if (!filename) { response.writeHead(404).end(); return; }
  const file = path.join(scratch, 'release', filename);
  const info = await stat(file);
  response.writeHead(200, { 'content-length': info.size, 'content-type': filename.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  assert.ok([major, minor, patch].every(Number.isInteger), 'Verification needs a stable x.y.z package version');
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  await mkdir(path.dirname(installed), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(path.join(scratch, 'release'));
  execFileSync('git', ['init', '-q', home]);
  await run(process.execPath, ['scripts/build-app.mjs'], { ...process.env, OMP_HOME_UPDATER_ENDPOINT: `${endpoint}/latest.json` });
  await cp(path.join(bundle, 'macos/omp-home.app'), installed, { recursive: true });
  const { OMP_HOME_UPDATER_ENDPOINT: _endpoint, ...defaultEnvironment } = process.env;
  await run(process.execPath, ['scripts/build-app.mjs'], { ...defaultEnvironment, OMP_HOME_APP_VERSION: nextVersion });
  await run(process.execPath, ['scripts/updater-json.mjs', '--url', `${endpoint}/omp-home.app.tar.gz`, '--output', path.join(scratch, 'release/latest.json')]);
  await cp(path.join(bundle, 'macos/omp-home.app.tar.gz'), path.join(scratch, 'release/omp-home.app.tar.gz'));
  record(`Built A=${pkg.version}, B=${nextVersion}; B restores the default HTTPS updater endpoint`);

  const first = await launch(3600);
  assert.match(await readFile(path.join(installed, 'Contents/Info.plist'), 'utf8'), new RegExp(`<string>${pkg.version.replaceAll('.', '\\.')}<\\/string>`));
  const initial = await api(first.url, '/api/state');
  await writeFile(path.join(scratch, 'initial-state.json'), JSON.stringify(initial, null, 2));
  record('App-served /api/state returns HTTP 200');
  const offset = (await log()).length;
  process.kill(first.hubPid, 'SIGKILL');
  const restarted = await until(async () => {
    const text = (await log()).slice(offset);
    return text.includes('window loaded') && text.includes('omp-home ready ') && text;
  }, 'owned hub crash recovery');
  const url = new URL(restarted.match(/omp-home ready (http:\/\/\S+)/)[1]);
  processIds.add(Number(restarted.match(/spawned hub pid=(\d+)/)[1]));
  record('Killed hub; supervisor restarted it and reloaded the window');
  await run(path.join(installed, 'Contents/MacOS/omp-home'), [], { ...process.env, OMP_HOME_CONFIG_DIR: config });
  await until(async () => (await log()).slice(offset).includes('window focused'), 'existing instance focuses its window');
  record('Second app launch exits and focuses the existing instance');
  await api(url, '/api/setup', { homePath: home, pstackRoot: null, migrateHome: true });
  const children = await until(() => {
    const rows = descendants(first.child.pid);
    return rows.some(row => /--mode rpc-ui/.test(row.command)) && rows;
  }, 'real omp RPC child starts');
  children.forEach(row => processIds.add(row.pid));
  record(`Real omp child observed: ${children.filter(row => /--mode rpc-ui/.test(row.command)).map(row => row.pid).join(', ')}`);
  await quit(first.child.pid);
  await until(() => [...processIds].every(pid => !alive(pid)), 'hub and omp children stop', 15000);
  record('Quitting stops owned hub and all observed omp descendants');

  const external = spawn(path.join(installed, 'Contents/MacOS/node'), [path.join(installed, 'Contents/Resources/hub/hub.mjs'), '--port', '0', '--no-open'], {
    env: { ...process.env, OMP_HOME_CONFIG_DIR: config, OMP_HOME_LOGIN_ENV: '1', OMP_HOME_RESOURCES: path.join(installed, 'Contents/Resources/hub/resources') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(external.pid);
  external.on('exit', () => running.delete(external.pid));
  let externalOutput = '';
  external.stdout.on('data', chunk => { externalOutput += chunk.toString(); });
  external.stderr.on('data', chunk => { externalOutput += chunk.toString(); });
  await until(() => externalOutput.includes('omp-home ready '), 'external hub starts');
  const attached = await launch(3600, 'already running');
  await quit(attached.child.pid);
  assert.ok(alive(external.pid), 'Desktop must not stop an attached external hub');
  descendants(external.pid).forEach(row => processIds.add(row.pid));
  const recovering = await launch(3600, 'already running');
  const recoveryOffset = (await log()).length;
  await quit(external.pid);
  const recovery = await until(async () => {
    const text = (await log()).slice(recoveryOffset);
    return text.includes('omp-home ready ') && /window loaded title="omp-home" url=http:/.test(text) && text;
  }, 'attached hub loss recovers with a new owned hub');
  processIds.add(Number(recovery.match(/spawned hub pid=(\d+)/)[1]));
  descendants(recovering.child.pid).forEach(row => processIds.add(row.pid));
  await quit(recovering.child.pid);
  await until(() => [...processIds].every(pid => !alive(pid)), 'external hub descendants stop');
  record('Exit-75 attachment preserves external ownership; external hub loss recovers with a new owned hub');

  updatePublished = true;
  const updating = await launch(15);
  const updated = await until(async () => {
    const text = await log();
    const match = text.match(new RegExp(`desktop launch version=${nextVersion.replaceAll('.', '\\.')} pid=(\\d+)`));
    return match && { text, pid: Number(match[1]) };
  }, 'signed update installs and app relaunches', 120000);
  running.add(updated.pid);
  assert.match(updated.text, new RegExp(`installed update ${nextVersion.replaceAll('.', '\\.')}; restarting`));
  const installedVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(installed, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(installedVersion, nextVersion);
  await until(async () => {
    const text = await log();
    const restarted = text.slice(text.lastIndexOf(`desktop launch version=${nextVersion}`));
    return restarted.includes('omp-home ready ') && /window loaded title="omp-home" url=http:/.test(restarted);
  }, 'updated app hub and window load');
  record(`Signed update installed and relaunched B=${installedVersion}, pid=${updated.pid}; Info.plist and running log agree`);
  const updatedChildren = descendants(updated.pid);
  record(`Updated app descendants: ${JSON.stringify(updatedChildren)}`);
  updatedChildren.forEach(row => processIds.add(row.pid));
  await quit(updated.pid);
  await until(() => [...processIds].every(pid => !alive(pid)) && !alive(updating.child.pid), 'updated app leaves no children', 15000);
  assert.doesNotMatch(await log(), /hub shutdown timed out/, 'Owned hubs must stop gracefully within ten seconds');
  record('PASS: native desktop lifecycle and signed local update proof');
} catch (error) {
  record(error.stack ?? String(error));
  const remaining = [...processIds].filter(alive);
  if (remaining.length) record(execFileSync('ps', ['-p', remaining.join(','), '-o', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }));
  throw error;
} finally {
  for (const pid of running) await quit(pid).catch(error => record(`Cleanup error: ${error.message}`));
  server.close();
  await writeFile(path.join(scratch, 'desktop.log'), await log().catch(() => ''));
  await writeFile(path.join(scratch, 'evidence.txt'), `${evidence.join('\n')}\n`);
  console.log(`Evidence and installed test app retained in ${scratch}`);
}
