import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachImagePreview, syncInputFiles } from '../src/preview.js';

// Using SVG files throughout this suite keeps normalizeOrientation() a
// pass-through (it never touches SVG — see orientation.test.js for its own
// coverage), so these tests stay focused on preview wiring itself.
function svgFile(name, content = '<svg/>') {
    return new File([content], name, { type: 'image/svg+xml' });
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

test('attachImagePreview shows the selected file and syncs input.files when DataTransfer is available', async (t) => {
    installFakes();
    t.after(uninstallFakes);

    const input = fakeInput();
    const img = { src: '' };
    let changed = null;
    attachImagePreview(input, img, { onChange: (f) => { changed = f; } });

    const file = svgFile('icon.svg');
    input.files = [file];
    await input.triggerChange();
    await flushMicrotasks();

    assert.ok(img.src.startsWith('data:image/svg+xml;base64,'));
    assert.equal(input.files[0], file, 'the (unchanged) file is still what the input will submit');
    assert.equal(changed, file);
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

test('only the most recently selected file reaches the preview when selections overlap', async (t) => {
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
