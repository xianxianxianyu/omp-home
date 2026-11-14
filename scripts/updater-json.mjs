import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  if (!['--bundle-dir', '--url', '--notes', '--output'].includes(key) || !args[index + 1]) throw new Error('Usage: node scripts/updater-json.mjs [--bundle-dir DIR] [--url ARTIFACT_URL] [--notes TEXT] [--output FILE]');
  options.set(key, args[index + 1]);
}
const bundle = path.resolve(options.get('--bundle-dir') ?? path.join(root, 'desktop/src-tauri/target/release/bundle/macos'));
const archives = (await readdir(bundle)).filter(file => file.endsWith('.app.tar.gz'));
if (archives.length !== 1) throw new Error(`Expected one .app.tar.gz in ${bundle}; found ${archives.length}`);
const archive = archives[0];
const signature = (await readFile(path.join(bundle, `${archive}.sig`), 'utf8')).trim();
if (!signature) throw new Error('Empty updater signature');
const app = archive.slice(0, -'.tar.gz'.length);
const plist = await readFile(path.join(bundle, app, 'Contents/Info.plist'), 'utf8');
const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
if (!version) throw new Error('Could not read built app version from Info.plist');
const repository = process.env.OMP_HOME_RELEASE_REPOSITORY ?? 'xianxianxianyu/omp-home';
const url = new URL(options.get('--url') ?? `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(archive)}`);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Artifact URL must use HTTPS or loopback HTTP');
const result = {
  version,
  notes: options.get('--notes') ?? `omp-home ${version}`,
  pub_date: new Date().toISOString(),
  platforms: { 'darwin-aarch64': { signature, url: url.href } },
};
const destination = path.resolve(options.get('--output') ?? path.join(bundle, 'latest.json'));
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`);
console.log(destination);
