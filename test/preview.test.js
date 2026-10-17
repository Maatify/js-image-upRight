import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachImagePreview, syncInputFiles } from '../src/preview.js';

// Using SVG files throughout this suite keeps normalizeOrientation() a
// pass-through (it never touches SVG — see orientation.test.js for its own
// coverage), so these tests stay focused on preview wiring itself.
function svgFile(name, content = '<svg/>') {
    return new File([content], name, { type: 'image/svg+xml' });
}

function pngFile(name) {
    return new File(['PNG-BYTES'], name, { type: 'image/png' });
}

class FakeFileReader {
    readAsDataURL(file) {
        file.arrayBuffer().then((buf) => {
            const result = 'data:' + file.type + ';base64,' + Buffer.from(buf).toString('base64');
            if (typeof this.onload === 'function') this.onload({ target: { result } });
        });
    }
}

class FakeDataTransfer {
    constructor() {
        this._files = [];
        this.items = { add: (file) => this._files.push(file) };
    }
    get files() {
        return this._files;
    }
}

function installFakes({ withDataTransfer = true } = {}) {
    globalThis.FileReader = FakeFileReader;
    if (withDataTransfer) globalThis.DataTransfer = FakeDataTransfer;
    else delete globalThis.DataTransfer;
}

function uninstallFakes() {
    delete globalThis.FileReader;
    delete globalThis.DataTransfer;
}

function fakeInput() {
    const listeners = {};
    return {
        files: [],
        addEventListener(type, handler) {
            listeners[type] = handler;
        },
        removeEventListener(type) {
            delete listeners[type];
        },
        async triggerChange() {
            await listeners.change({ target: this });
        },
    };
}

async function flushMicrotasks() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

test('attachImagePreview shows the selected file as an object URL and syncs input.files', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    let changed = null;
    let meta = null;
    attachImagePreview(input, img, { onChange: (f, m) => { changed = f; meta = m; } });

    const file = svgFile('icon.svg');
    input.files = [file];
    await input.triggerChange();
    await flushMicrotasks();

    assert.ok(img.src.startsWith('blob:'), 'prefers a lightweight object URL over a full data: URL');
    assert.equal(input.files[0], file, 'the (unchanged) file is still what the input will submit');
    assert.equal(changed, file);
    assert.equal(meta.filesSynced, true);
});

test('falls back to a data: URL when the environment has no URL.createObjectURL', async (t) => {
    installFakes();
    const originalCreateObjectURL = URL.createObjectURL;
    delete URL.createObjectURL;
    t.after(() => {
        URL.createObjectURL = originalCreateObjectURL;
        uninstallFakes();
    });

    const input = fakeInput();
    const img = { src: '' };
    attachImagePreview(input, img, {});

    input.files = [svgFile('icon.svg')];
    await input.triggerChange();
    await flushMicrotasks();

    assert.ok(img.src.startsWith('data:image/svg+xml;base64,'));
});

test('releases the previous preview\'s object URL when a new file is selected', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const revoked = [];
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
    t.after(() => { URL.revokeObjectURL = originalRevoke; });

    const input = fakeInput();
    const img = { src: '' };
    attachImagePreview(input, img, {});

    input.files = [svgFile('first.svg')];
    await input.triggerChange();
    await flushMicrotasks();
    const firstUrl = img.src;

    input.files = [svgFile('second.svg')];
    await input.triggerChange();
    await flushMicrotasks();

    assert.deepEqual(revoked, [firstUrl]);
    assert.notEqual(img.src, firstUrl);
});

test('detach() releases the current preview\'s object URL', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const revoked = [];
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
    t.after(() => { URL.revokeObjectURL = originalRevoke; });

    const input = fakeInput();
    const img = { src: '' };
    const detach = attachImagePreview(input, img, {});

    input.files = [svgFile('icon.svg')];
    await input.triggerChange();
    await flushMicrotasks();
    const url = img.src;

    detach();
    assert.deepEqual(revoked, [url]);
});

test('attachImagePreview rejects an invalid file via validate()/onInvalid() and never touches the preview', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    let invalidFile = null;
    attachImagePreview(input, img, {
        validate: (file) => file.type === 'image/png',
        onInvalid: (file) => { invalidFile = file; },
    });

    const file = svgFile('icon.svg');
    input.files = [file];
    await input.triggerChange();
    await flushMicrotasks();

    assert.equal(img.src, '');
    assert.equal(invalidFile, file);
});

test('only the most recently selected file reaches the preview when two valid selections overlap', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    const seen = [];
    attachImagePreview(input, img, { onChange: (f) => seen.push(f.name) });

    input.files = [svgFile('first.svg')];
    const firstSelection = input.triggerChange();
    input.files = [svgFile('second.svg')];
    const secondSelection = input.triggerChange();

    await Promise.all([firstSelection, secondSelection]);
    await flushMicrotasks();

    assert.deepEqual(seen, ['second.svg'], 'the first, now-stale selection must never reach onChange');
});

test('a rejected selection invalidates an earlier valid one still normalizing, even though rejection never increments past validation', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    const changes = [];
    const invalids = [];
    attachImagePreview(input, img, {
        validate: (file) => file.type !== 'image/png',
        onInvalid: (file) => invalids.push(file.name),
        onChange: (file) => changes.push(file.name),
    });

    input.files = [svgFile('valid.svg')];
    const validSelection = input.triggerChange();

    // Picked before validSelection's normalization settles; this one fails
    // validate() and used to return without retiring the valid selection.
    input.files = [pngFile('rejected.png')];
    const invalidSelection = input.triggerChange();

    await Promise.all([validSelection, invalidSelection]);
    await flushMicrotasks();

    assert.deepEqual(invalids, ['rejected.png']);
    assert.deepEqual(changes, [], 'the stale valid selection must never reach onChange once a later selection arrived');
    assert.equal(img.src, '', 'the preview must not show the stale valid selection either');
});

test('an emptied selection (user cancels the file dialog) invalidates an earlier one still normalizing', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    const changes = [];
    attachImagePreview(input, img, { onChange: (f) => changes.push(f.name) });

    input.files = [svgFile('valid.svg')];
    const validSelection = input.triggerChange();

    input.files = []; // e.g. the user re-opened and cancelled the file picker
    const emptySelection = input.triggerChange();

    await Promise.all([validSelection, emptySelection]);
    await flushMicrotasks();

    assert.deepEqual(changes, []);
    assert.equal(img.src, '');
});

test('detach() stops future selections and invalidates one still in flight', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    let changed = null;
    const detach = attachImagePreview(input, img, { onChange: (f) => { changed = f; } });

    input.files = [svgFile('a.svg')];
    const pending = input.triggerChange();
    detach();
    await pending;
    await flushMicrotasks();

    assert.equal(changed, null, 'a selection in flight when detach() runs must not reach onChange');
});

test('onChange reports filesSynced: false when DataTransfer is unavailable', async (t) => {
    installFakes({ withDataTransfer: false });
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    let meta = null;
    attachImagePreview(input, img, { onChange: (f, m) => { meta = m; } });

    const file = svgFile('icon.svg');
    input.files = [file];
    await input.triggerChange();
    await flushMicrotasks();

    assert.equal(meta.filesSynced, false);
    assert.equal(input.files[0], file, 'the input keeps the original file when the swap is not possible');
});

test('syncInputFiles returns false and leaves input.files alone without DataTransfer', () => {
    installFakes({ withDataTransfer: false });
    try {
        const input = { files: ['original'] };
        const ok = syncInputFiles(input, 'normalized');
        assert.equal(ok, false);
        assert.deepEqual(input.files, ['original']);
    } finally {
        uninstallFakes();
    }
});
