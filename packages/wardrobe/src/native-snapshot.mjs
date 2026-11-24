import { cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { git } from './proc.mjs';
import { createHash } from 'node:crypto';

const PRIVATE = /^(?:\.git|\.scratch|node_modules|\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|models(?:-store)?\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/;
export const publicSource = path => !PRIVATE.test(basename(path)) && !lstatSync(path).isSymbolicLink();

/** Content identity shared by authoring, normalization and workflow evidence. */
export function sourceDigest(root) {
  return createHash('sha256').update(JSON.stringify(sourceFiles(root))).digest('hex');
}

/** Ordered public file identities for evidence and durable workflow handoffs. */
export function sourceFiles(root) {
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),values=[];
  const walk=path=>{for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(PRIVATE.test(entry.name))continue;
    const absolute=join(path,entry.name);
    if(entry.isSymbolicLink())throw new Error('Source symlinks require separate review');
    if(entry.isDirectory())walk(absolute);
    else values.push([relative(root,absolute),lstatSync(absolute).mode&0o111,hash(readFileSync(absolute))]);
  }};
  walk(root);return values;
}

export function copyPublicSource(source, target) {
  const root = realpathSync(source);
  cpSync(root, target, { recursive: true, filter: path => path !== join(root, 'settings.json') && publicSource(path) });
}

/** One immutable snapshot for the existing fixed Git review/install protocol. */
export async function withLocalSnapshot(root, source, callback, env) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const snapshot = mkdtempSync(join(root, 'revision-')), work = join(snapshot, 'work'), bare = join(snapshot, 'git/preset.git');
  mkdirSync(dirname(bare)); copyPublicSource(source, work);
  inspectPublicSource(work);
  const run = args => git(['-C', work, ...args], { env });
  await run(['init', '-q']); await run(['add', '--force', '.']);
  await run(['-c', 'user.name=Wardrobe Snapshot', '-c', 'user.email=local@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Reviewed local preset snapshot']);
  const commit = await run(['rev-parse', 'HEAD']);
  await git(['clone', '--bare', '--no-hardlinks', '-q', work, bare], { env });
  await git(['--git-dir', bare, 'update-server-info'], { env });
  const server = createServer((request, response) => {
    try {
      const path = resolve(snapshot, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      if (!path.startsWith(bare + sep) || !statSync(path).isFile()) { response.writeHead(404).end(); return; }
      createReadStream(path).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    return await callback(`git:http://127.0.0.1:${server.address().port}/git/preset.git@${commit}`);
  } finally { if (server.listening) await new Promise(done => server.close(done)); }
}

/** Reject live links and common embedded secrets before making public artifacts. */
export function inspectPublicSource(root) {
  const files = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('请先打包资源或声明设备绑定：' + file);
      if (PRIVATE.test(entry.name)) throw new Error('预设含有私密或生成文件：' + file);
      if (entry.isDirectory()) walk(file); else {
        const bytes = readFileSync(file);
        if (!bytes.includes(0)) {
          const value = bytes.toString('utf8');
          if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,})\b/.test(value) || /["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|clientSecret|authorization|token|secret)["']\s*:\s*["'](?!\{\{|\$\{|<|YOUR_|REPLACE_|example|placeholder|fixture)[^"']{8,}["']/i.test(value)) throw new Error('资源疑似含有凭据，请改用设备绑定：' + file);
          if (/\/(?:Users|home)\/(?!you(?:\/|r\b)|user(?:\/|\b)|example(?:\/|\b))[^\s/"']+\//.test(value)) throw new Error('资源含有本机用户路径，请改用设备绑定：' + file);
        }
        files.push(file);
      }
    }
  };
  if (!existsSync(root)) throw new Error('预设源码不存在');
  walk(root); return files;
}
