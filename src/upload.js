/**
 * Uploads a body (typically FormData holding the normalized image) via
 * XMLHttpRequest, with upload progress and the ability to abort — things
 * `fetch()` still cannot do natively for the upload direction.
 *
 * @param {string} url
 * @param {FormData|Blob|string} body
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   onProgress?: (percent: number, event: ProgressEvent) => void,
 *   timeout?: number,
 * }} [options] `timeout` (ms) aborts the upload itself if it hasn't
 *   finished in time, rejecting with an error whose `timedOut` is `true` —
 *   the counterpart of `abort()`'s `error.aborted`. Omit it (or 0) for no
 *   timeout, matching the native `XMLHttpRequest.timeout` default.
 * @returns {{ promise: Promise<{status: number, responseText: string}>, abort: () => void }}
 */
export function uploadWithProgress(url, body, options = {}) {
    const { method = 'POST', headers = {}, onProgress, timeout } = options;
    const xhr = new XMLHttpRequest();

    const promise = new Promise((resolve, reject) => {
        xhr.open(method, url, true);

        Object.keys(headers).forEach((key) => {
            xhr.setRequestHeader(key, headers[key]);
        });

        if (typeof timeout === 'number' && timeout > 0) {
            xhr.timeout = timeout;
        }

        if (xhr.upload && typeof onProgress === 'function') {
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress((event.loaded / event.total) * 100, event);
                }
            };
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve({ status: xhr.status, responseText: xhr.responseText });
            } else {
                const error = new Error('Upload failed with status ' + xhr.status);
                error.status = xhr.status;
                error.responseText = xhr.responseText;
                reject(error);
            }
        };

        xhr.onerror = () => {
            reject(new Error('Network error during upload'));
        };

        xhr.onabort = () => {
            const error = new Error('Upload aborted');
            error.aborted = true;
            reject(error);
        };

        xhr.ontimeout = () => {
            const error = new Error('Upload timed out');
            error.timedOut = true;
            reject(error);
        };

        xhr.send(body);
    });

    return {
        promise,
        abort() {
            xhr.abort();
        },
    };
}
