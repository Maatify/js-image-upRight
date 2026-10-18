import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadWithProgress } from '../src/upload.js';

class FakeXMLHttpRequest {
    constructor() {
        this.upload = {};
        this.requestHeaders = {};
        this.status = 0;
        this.responseText = '';
    }
    open(method, url) {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(key, value) {
        this.requestHeaders[key] = value;
    }
    send(body) {
        this.sentBody = body;
        FakeXMLHttpRequest.instances.push(this);
    }
    abort() {
        if (typeof this.onabort === 'function') this.onabort();
    }
    // Test helper, not part of the real XHR API.
    timedOut() {
        if (typeof this.ontimeout === 'function') this.ontimeout();
    }
    // Test helper, not part of the real XHR API.
    respond(status, responseText) {
        this.status = status;
        this.responseText = responseText;
        if (typeof this.onload === 'function') this.onload();
    }
    fail() {
        if (typeof this.onerror === 'function') this.onerror();
    }
    progress(loaded, total) {
        if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded, total });
    }
}
FakeXMLHttpRequest.instances = [];

function installFakeXhr() {
    FakeXMLHttpRequest.instances = [];
    globalThis.XMLHttpRequest = FakeXMLHttpRequest;
}
function uninstallFakeXhr() {
    delete globalThis.XMLHttpRequest;
}

test('resolves with status and response text on a 2xx response', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body');
    const xhr = FakeXMLHttpRequest.instances[0];
    xhr.respond(200, '{"ok":true}');

    const result = await promise;
    assert.deepEqual(result, { status: 200, responseText: '{"ok":true}' });
});

test('rejects with the status and response text on a non-2xx response', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body');
    const xhr = FakeXMLHttpRequest.instances[0];
    xhr.respond(422, '{"message":"bad"}');

    await assert.rejects(promise, (err) => {
        assert.equal(err.status, 422);
        assert.equal(err.responseText, '{"message":"bad"}');
        return true;
    });
});

test('rejects on a network error', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body');
    FakeXMLHttpRequest.instances[0].fail();

    await assert.rejects(promise, /Network error/);
});

test('abort() rejects the promise with an aborted error', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise, abort } = uploadWithProgress('/api/upload', 'body');
    abort();

    await assert.rejects(promise, (err) => {
        assert.equal(err.aborted, true);
        return true;
    });
});

test('reports upload progress as a percentage', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const progressValues = [];
    const { promise } = uploadWithProgress('/api/upload', 'body', {
        onProgress: (percent) => progressValues.push(percent),
    });
    const xhr = FakeXMLHttpRequest.instances[0];

    xhr.progress(25, 100);
    xhr.progress(100, 100);
    xhr.respond(200, 'ok');
    await promise;

    assert.deepEqual(progressValues, [25, 100]);
});

test('sends custom method and headers', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body', {
        method: 'PUT',
        headers: { 'X-Custom': '1' },
    });
    const xhr = FakeXMLHttpRequest.instances[0];
    xhr.respond(200, 'ok');
    await promise;

    assert.equal(xhr.method, 'PUT');
    assert.equal(xhr.requestHeaders['X-Custom'], '1');
});

test('sets xhr.timeout when a timeout option is given', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body', { timeout: 5000 });
    const xhr = FakeXMLHttpRequest.instances[0];

    assert.equal(xhr.timeout, 5000);
    xhr.respond(200, 'ok');
    await promise;
});

test('leaves xhr.timeout unset when no timeout option is given', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body');
    const xhr = FakeXMLHttpRequest.instances[0];

    assert.equal(xhr.timeout, undefined);
    xhr.respond(200, 'ok');
    await promise;
});

test('ontimeout rejects the promise with a timedOut error', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body', { timeout: 5000 });
    const xhr = FakeXMLHttpRequest.instances[0];
    xhr.timedOut();

    await assert.rejects(promise, (err) => {
        assert.equal(err.timedOut, true);
        assert.equal(err.aborted, undefined, 'a timeout is not the same as an explicit abort()');
        return true;
    });
});

test('a non-positive timeout option is ignored rather than passed through as-is', async (t) => {
    installFakeXhr();
    t.after(uninstallFakeXhr);

    const { promise } = uploadWithProgress('/api/upload', 'body', { timeout: 0 });
    const xhr = FakeXMLHttpRequest.instances[0];

    assert.equal(xhr.timeout, undefined);
    xhr.respond(200, 'ok');
    await promise;
});
