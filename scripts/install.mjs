#!/usr/bin/env node
/** Portable files-only installation. This script never reads or writes user data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['StoryBuilder', 'StoryReview'];
const sha = data => createHash('sha256').update(data).digest('hex');
const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function within(root, target) {
    const relative = path.relative(root, target);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('An installation path escapes the selected SillyTavern directory.');
    return target;
}

async function rejectLinks(root, target) {
    within(root, target);
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links in installation paths are not supported.');
    }
}

async function atomic(target, data) {
    const temporary = path.join(path.dirname(target), '.sw-' + randomUUID().slice(0, 8) + '.tmp');
    await fs.writeFile(temporary, data, { flag: 'wx' });
    try { await fs.rename(temporary, target); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

export async function install({ target, apply = false, packageRoot = PACKAGE_ROOT } = {}) {
    if (typeof target !== 'string' || !target.trim()) throw new Error('Pass --target with the path to your SillyTavern installation.');
    const root = await fs.realpath(path.resolve(target));
    for (const expected of ['package.json', 'public/script.js', 'public/scripts/extensions']) {
        if (!await exists(path.join(root, expected))) throw new Error('The target does not look like a SillyTavern installation.');
    }
    const base = within(root, path.join(root, 'public/scripts/extensions/third-party'));
    await rejectLinks(root, base);
    const files = [];
    for (const extension of EXTENSIONS) {
        const source = path.join(packageRoot, 'extensions', extension);
        const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
        if (manifest.display_name !== (extension === 'StoryBuilder' ? 'Story Builder' : 'Story Review')) throw new Error('An extension manifest does not match the expected package.');
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
            if (!entry.isFile() || !(entry.name.endsWith('.js') || entry.name.endsWith('.css') || entry.name === 'manifest.json')) continue;
            const destination = within(root, path.join(base, extension, entry.name));
            await rejectLinks(root, destination);
            const data = await fs.readFile(path.join(source, entry.name));
            const before = await exists(destination) ? await fs.readFile(destination) : null;
            if (before && before.equals(data)) continue;
            files.push({ extension, name: entry.name, destination, data, before, version: manifest.version });
        }
    }
    const result = { applied: false, changedFiles: files.map(file => `${file.extension}/${file.name}`),
        settingsChanged: false, userDataRead: false, reloadRequired: files.length > 0 };
    if (!apply || !files.length) return result;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = within(root, path.join(root, 'backups', `story-workflow-${stamp}-${randomUUID().slice(0, 8)}`));
    await rejectLinks(root, backup);
    await fs.mkdir(backup, { recursive: true });
    const receipt = files.map(file => ({ path: `${file.extension}/${file.name}`, version: file.version,
        beforeSha256: file.before === null ? null : sha(file.before), installedSha256: sha(file.data) }));
    for (const file of files) {
        if (file.before === null) continue;
        const saved = within(root, path.join(backup, file.extension, file.name));
        await fs.mkdir(path.dirname(saved), { recursive: true });
        await fs.writeFile(saved, file.before, { flag: 'wx' });
    }
    await fs.writeFile(path.join(backup, 'installation.json'), JSON.stringify({ files: receipt, settingsChanged: false }, null, 2) + '\n', { flag: 'wx' });
    const written = [];
    try {
        for (const file of files) {
            await rejectLinks(root, file.destination);
            const current = await exists(file.destination) ? await fs.readFile(file.destination) : null;
            if (file.before === null ? current !== null : current === null || !current.equals(file.before)) throw new Error('An installed file changed during preparation; installation stopped.');
            await fs.mkdir(path.dirname(file.destination), { recursive: true });
            await atomic(file.destination, file.data);
            written.push(file);
        }
    } catch (error) {
        for (const file of written.reverse()) {
            within(root, file.destination);
            // A concurrent edit belongs to the user; leave it in place.
            const current = await fs.readFile(file.destination).catch(() => null);
            if (!current || !current.equals(file.data)) continue;
            if (file.before === null) await fs.unlink(file.destination);
            else await atomic(file.destination, file.before);
        }
        throw error;
    }
    return { ...result, applied: true, backup };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    try {
        if (args.includes('--help')) {
            console.log('Usage: node scripts/install.mjs --target /path/to/SillyTavern [--apply]\nWithout --apply, only the planned file list is printed.');
        } else {
            let target, apply = false;
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--target' && typeof args[i + 1] === 'string') target = args[++i];
                else if (args[i] === '--apply') apply = true;
                else throw new Error('Unknown option. Use --help for usage.');
            }
            console.log(JSON.stringify(await install({ target, apply }), null, 2));
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
