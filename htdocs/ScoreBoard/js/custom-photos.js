/**
 * ScoreBoard custom background photos: pictures the operator picked for the Custom theme.
 * They are stored in this browser's IndexedDB only, so they show on this device; every other
 * device shows the theme's color gradient instead. A photo is identified by an 8-character
 * lowercase hex id, which is the id used inside a custom theme key (see shared.js).
 *
 * Every function fails quietly (empty result or null) when IndexedDB is unavailable, except
 * savePhoto, which throws an Error with a message that is safe to show to the user.
 */

const DB_NAME = 'scoreboardCustomPhotos';
const STORE = 'photos';
const MAX_SIDE = 1920;          // longest side of a stored photo, in pixels
const JPEG_QUALITY = 0.85;
const NAME_MAX = 30;            // longest label kept for a photo

let dbPromise = null;
// Object URLs already created for stored photos, by photo id
const urlCache = new Map();

/** True when this browser can store photos. */
export function photosSupported() {
    try {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch (error) {
        return false;
    }
}

/** Opens (once) the photo database. A failed open is not remembered, so a later call can retry. */
function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            if (!photosSupported()) {
                reject(new Error('Photo storage is not available'));
                return;
            }
            let request;
            try {
                request = indexedDB.open(DB_NAME, 1);
            } catch (error) {
                reject(error);
                return;
            }
            request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
}

/**
 * Runs one request in a transaction and resolves with its result once the transaction completes.
 * @param {'readonly'|'readwrite'} mode
 * @param {function(IDBObjectStore): IDBRequest} makeRequest
 */
async function run(mode, makeRequest) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = makeRequest(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Photo storage was interrupted'));
    });
}

/** A new random 8-character lowercase hex id. */
function newPhotoId() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Loads an image file into an <img> element. */
function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be opened.')); };
        image.src = url;
    });
}

/** Shrinks a picture to MAX_SIDE on its longest side and returns it as a JPEG Blob. */
async function shrinkToJpeg(file) {
    const image = await loadImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('That picture could not be saved.'))), 'image/jpeg', JPEG_QUALITY);
    });
}

/**
 * Stores a picture chosen by the user.
 * @param {File} file The picture.
 * @param {string} color The theme color it is paired with, '#rrggbb' (used when the photo is picked again).
 * @returns {Promise<{id: string, color: string, name: string}>}
 */
export async function savePhoto(file, color) {
    if (!photosSupported()) throw new Error('This browser cannot store photos. The color will still be used.');
    if (!file || !/^image\//.test(file.type || '')) throw new Error('Please choose a picture file.');
    const blob = await shrinkToJpeg(file);
    const name = (file.name || 'Photo').replace(/\.[^/.]+$/, '').trim().slice(0, NAME_MAX) || 'Photo';
    const record = { id: newPhotoId(), blob, color, name, createdAt: Date.now() };
    try {
        await run('readwrite', (store) => store.put(record));
    } catch (error) {
        throw new Error('The photo could not be saved on this device.');
    }
    return { id: record.id, color, name };
}

/** An object URL for a stored photo, or null when it is missing or storage is unavailable. */
export async function getPhotoUrl(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    try {
        const record = await run('readonly', (store) => store.get(id));
        if (!record || !record.blob) return null;
        const url = URL.createObjectURL(record.blob);
        urlCache.set(id, url);
        return url;
    } catch (error) {
        return null;
    }
}

/** The stored photos, newest first: [{ id, color, name, createdAt }]. */
export async function listPhotos() {
    try {
        const records = await run('readonly', (store) => store.getAll());
        return (records || [])
            .map(({ id, color, name, createdAt }) => ({ id, color, name, createdAt }))
            .sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
        return [];
    }
}

/** Removes a stored photo. Resolves true when it was removed. */
export async function deletePhoto(id) {
    try {
        await run('readwrite', (store) => store.delete(id));
        const url = urlCache.get(id);
        if (url) URL.revokeObjectURL(url);
        urlCache.delete(id);
        return true;
    } catch (error) {
        return false;
    }
}
