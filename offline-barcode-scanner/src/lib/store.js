'use client';
import { useEffect, useState, useCallback } from 'react';
import { loadItems, saveItems } from '@/lib/db';

export function useItemsStore() {
const [items, setItems] = useState([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
(async () => {
setLoading(true);
const initial = await loadItems();
setItems(initial);
setLoading(false);
})();
}, []);

// persist on change
useEffect(() => {
if (!loading) saveItems(items);
}, [items, loading]);

const addItem = useCallback((serial, extras = {}) => {
if (!serial) return;
const exists = items.some((it) => it.serial === serial);
setItems((prev) => exists ? prev : [{ serial, location: '', mac: '', ip: '', ...extras, createdAt: Date.now() }, ...prev]);
}, [items]);

const updateItem = useCallback((serial, patch) => {
setItems((prev) => prev.map((it) => (it.serial === serial ? { ...it, ...patch } : it)));
}, []);

const removeItem = useCallback((serial) => {
setItems((prev) => prev.filter((it) => it.serial !== serial));
}, []);

const clearAll = useCallback(() => setItems([]), []);

return { items, loading, addItem, updateItem, removeItem, clearAll };
}