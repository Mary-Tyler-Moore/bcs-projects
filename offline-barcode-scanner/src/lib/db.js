import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

const KEY = 'scanned_items_v1';

export async function loadItems() {
const arr = (await idbGet(KEY)) || [];
return Array.isArray(arr) ? arr : [];
}

export async function saveItems(items) {
return idbSet(KEY, items);
}

export async function clearItems() {
return idbDel(KEY);
}