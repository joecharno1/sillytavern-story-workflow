import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../../scripts/install.mjs';

async function fixture(run) {
    // Keep Windows fixture paths below legacy tool path limits.
    const scratch = fileURLToPath(new URL('../../test-results/', import.meta.url));
    await fs.mkdir(scratch, { recursive: true });
    const temporaryBase = await fs.realpath(scratch);
    const root = await fs.mkdtemp(path.join(temporaryBase, 'story-workflow-test-'));
    try {
        await fs.mkdir(path.join(root, 'public/scripts/extensions/third-party'), { recursive: true });
        await fs.mkdir(path.join(root, 'data'), { recursive: true });
        await fs.writeFile(path.join(root, 'public/script.js'), '// synthetic host');
        await fs.writeFile(path.join(root, 'package.json'), '{"name":"synthetic-host"}');
        await fs.writeFile(path.join(root, 'data/settings.json'), 'SYNTHETIC SETTINGS MUST REMAIN UNCHANGED');
        await run(root);
    } finally {
        assert.equal(path.dirname(await fs.realpath(root)), temporaryBase);
        assert.ok(path.basename(root).startsWith('story-workflow-test-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('installer preview does not write, apply backs up replaced files and never changes settings', async () => {
    await fixture(async root => {
        const target = path.join(root, 'public/scripts/extensions/third-party/StoryBuilder/index.js');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, '// old synthetic extension');
        const before = await fs.readFile(path.join(root, 'data/settings.json'));
        const preview = await install({ target: root });
        assert.equal(preview.applied, false); assert.ok(preview.changedFiles.length > 2);
        assert.equal(await fs.readFile(target, 'utf8'), '// old synthetic extension');
        const result = await install({ target: root, apply: true });
        assert.equal(result.applied, true);
        assert.equal(await fs.readFile(path.join(result.backup, 'StoryBuilder/index.js'), 'utf8'), '// old synthetic extension');
        assert.deepEqual(await fs.readFile(path.join(root, 'data/settings.json')), before);
        assert.equal(result.settingsChanged, false); assert.equal(result.userDataRead, false);
        const again = await install({ target: root, apply: true });
        assert.deepEqual(again.changedFiles, []); assert.equal(again.applied, false);
    });
});

test('installer rejects a target that is not a SillyTavern layout before writing', async () => {
    await fixture(async root => {
        await fs.unlink(path.join(root, 'public/script.js'));
        await assert.rejects(install({ target: root, apply: true }), /does not look like/);
        await assert.rejects(fs.access(path.join(root, 'public/scripts/extensions/third-party/StoryBuilder')), { code: 'ENOENT' });
    });
});
