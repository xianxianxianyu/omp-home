import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'desktop');
const native = path.join(desktop, 'src-tauri');
const runtimeVersion = '26.11.1';
const runtimeName = `node-v${runtimeVersion}-darwin-arm64`;
const cache = path.join(homedir(), '.cache/omp-home');
const archive = path.join(cache, `${runtimeName}.tar.gz`);
const runtime = path.join(cache, runtimeName, 'bin/node');

function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}
async function exists(file) { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, response.body);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The desktop distribution targets macOS arm64; build it on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = process.env.OMP_HOME_APP_VERSION ?? pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`Invalid app version: ${version}`);
const repository = process.env.OMP_HOME_RELEASE_REPOSITORY ?? 'xianxianxianyu/omp-home';
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('OMP_HOME_RELEASE_REPOSITORY must be owner/repo');
const endpoint = new URL(process.env.OMP_HOME_UPDATER_ENDPOINT ?? `https://github.com/${repository}/releases/latest/download/latest.json`);
const localUpdate = endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
if (endpoint.protocol !== 'https:' && !localUpdate) throw new Error('Updater endpoint must use HTTPS (loopback HTTP is allowed for local update verification only).');
const env = { ...process.env, PATH: `${path.join(homedir(), '.cargo/bin')}:${process.env.PATH ?? ''}` };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const localKey = path.join(homedir(), '.config/omp-home-release/updater.key');
  if (!await exists(localKey)) throw new Error('Set TAURI_SIGNING_PRIVATE_KEY or generate ~/.config/omp-home-release/updater.key (see desktop/README.md).');
  env.TAURI_SIGNING_PRIVATE_KEY = localKey;
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';

await run(process.execPath, ['scripts/build-hub.mjs']);
await mkdir(cache, { recursive: true });
const base = `https://nodejs.org/dist/v${runtimeVersion}/`;
const sums = path.join(cache, `${runtimeName}-SHASUMS256.txt`);
if (!await exists(sums)) await download(`${base}SHASUMS256.txt`, sums);
const entry = (await readFile(sums, 'utf8')).split('\n').find(line => line.endsWith(`  ${runtimeName}.tar.gz`));
if (!entry || !/^[a-f\d]{64}  /.test(entry)) throw new Error('Official Node checksum entry is missing or invalid');
if (!await exists(archive)) await download(`${base}${runtimeName}.tar.gz`, archive);
if (await digest(archive) !== entry.slice(0, 64)) {
  await rm(archive);
  throw new Error('Node archive checksum mismatch; removed cache entry. Retry to download it again.');
}
// Extract again from the verified archive rather than trusting a previously unpacked executable.
await run('tar', ['-xzf', archive, '-C', cache, `${runtimeName}/bin/node`]);
await mkdir(path.join(native, 'binaries'), { recursive: true });
await copyFile(runtime, path.join(native, 'binaries/node-aarch64-apple-darwin'));
await chmod(path.join(native, 'binaries/node-aarch64-apple-darwin'), 0o755);
const bundledHub = path.join(native, 'resources/hub');
await rm(bundledHub, { force: true, recursive: true });
await mkdir(path.dirname(bundledHub), { recursive: true });
await cp(path.join(root, 'dist/hub'), bundledHub, { recursive: true });
const config = {
  version,
  plugins: { updater: { endpoints: [endpoint.href], dangerousInsecureTransportProtocol: localUpdate } },
};
console.log(`Building omp-home ${version}; updater ${endpoint.href}`);
await run('pnpm', ['exec', 'tauri', 'build', '--config', JSON.stringify(config)], desktop, env);
console.log(`App, DMG and signed updater artifacts: ${path.join(native, 'target/release/bundle')}`);
