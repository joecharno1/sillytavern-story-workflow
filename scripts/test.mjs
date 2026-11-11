/** Explicit file discovery keeps npm test portable across Windows and POSIX shells. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const folder of ['builder', 'review', 'package']) {
    for (const name of (await fs.readdir(path.join(root, 'tests', folder))).sort()) {
        if (name.endsWith('.test.mjs')) files.push(path.join('tests', folder, name));
    }
}
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
