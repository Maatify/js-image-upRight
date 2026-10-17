/**
 * Retries loading an <img>'s `src` a few times with a growing delay.
 *
 * Signed/presigned storage URLs (S3, DigitalOcean Spaces, ...) can briefly
 * 404 right after upload — the object isn't always readable from every
 * storage node yet — and resolve on their own within a few seconds.
 * Appending a cache-busting query string isn't an option for a signed URL
 * (any extra, unsigned parameter invalidates the signature), so this
 * reloads the *exact same* URL after a delay instead.
 *
 * State is kept in a WeakMap keyed by the <img> element rather than a
 * property stashed on the element itself, so it never leaks onto objects
 * callers don't own and is collected automatically once the element is
 * garbage-collected.
 *
 * IMPORTANT: a scheduled retry holds a real reference to the <img> element
 * via its setTimeout closure, which keeps the element (and whatever DOM
 * subtree still references it) alive until the retry finishes or gives up.
 * If your code discards the element before that (e.g. re-rendering a list
 * with `container.innerHTML = ''`), call `cancelImageRetry(imgEl)` first.
 */

const retryState = new WeakMap();

const DEFAULT_DELAYS_MS = [700, 1500, 3000];

/**
 * @param {HTMLImageElement} imgEl
 * @param {string} src
 * @param {{ delays?: number[], onGiveUp?: () => void }} [options]
 */
export function loadImageWithRetry(imgEl, src, options = {}) {
    if (!imgEl || !src) return;

    cancelImageRetry(imgEl);

    const delays = options.delays || DEFAULT_DELAYS_MS;
    const onGiveUp = options.onGiveUp;
    const token = {};
    const state = { token, timer: null };
    retryState.set(imgEl, state);

    let attempt = 0;
    imgEl.onerror = () => {
        const current = retryState.get(imgEl);
        if (!current || current.token !== token) return;

        if (attempt < delays.length) {
            const delay = delays[attempt];
            attempt += 1;
            current.timer = setTimeout(() => {
                const stillCurrent = retryState.get(imgEl);
                if (!stillCurrent || stillCurrent.token !== token) return;
                stillCurrent.timer = null;
                imgEl.removeAttribute('src');
                imgEl.src = src;
            }, delay);
        } else {
            imgEl.onerror = null;
            retryState.delete(imgEl);
            if (typeof onGiveUp === 'function') onGiveUp();
        }
    };

    imgEl.src = src;
}

/**
 * Cancels any retry in flight for `imgEl` and clears its retry `onerror`
 * handler's pending timer. Safe to call even when nothing is pending.
 *
 * @param {HTMLImageElement} imgEl
 */
export function cancelImageRetry(imgEl) {
    const state = imgEl && retryState.get(imgEl);
    if (!state) return;
    if (state.timer !== null) clearTimeout(state.timer);
    retryState.delete(imgEl);
    imgEl.onerror = null;
}
