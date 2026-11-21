# Node templates

Copy these into `scripts/` in the target project. Each is ESM, Node 22, zero
dependencies.

## 1. Recursive walker

```js
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

export async function walk({ root, accept, out = [] }) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk({ root: path, accept, out });
    else if (entry.isFile() && accept(path)) out.push(path);
  }
  return out;
}

const files = await walk({ root: resolve('.'), accept: (p) => p.endsWith('.mjs') });
process.stdout.write(JSON.stringify({ count: files.length, files }, null, 2));
```

## 2. Atomic write

A crash must not leave a half-written file.

```js
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeAtomic({ path, content }) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${randomUUID()}`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}
```

## 3. Spawn with a timeout

Use this when a script must call a real CLI.

```js
import { spawn } from 'node:child_process';

export function run({ command, args = [], timeoutMs = 10_000, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${command}`)); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} exited ${code}: ${stderr.trim()}`), { code, stdout, stderr }));
    });
  });
}
```

## 4. JSON / CSV transform

```js
import { readFile, writeFile } from 'node:fs/promises';

const rows = JSON.parse(await readFile('input.json', 'utf8'));
const out = rows
  .filter((r) => r.active === true)
  .map((r) => ({ id: r.id, name: r.name.trim() }))
  .sort((a, b) => a.name.localeCompare(b.name));

const header = 'id,name';
const csv = [header, ...out.map((r) => `${r.id},"${r.name.replaceAll('"', '""')}"`)].join('\n');
await writeFile('out.csv', csv + '\n', 'utf8');
process.stdout.write(JSON.stringify({ rows: out.length }) + '\n');
```

## Output contract

- JSON to stdout, human prose to stderr.
- Exit 0 on success, non-zero on failure, with the failing path in the message.
- The shell tool caps stdout at 4000 chars: print a summary, not the payload.
