// Mock foreman data for development
export async function lookupMacIpBySerial(serial) {
try {
const res = await fetch(`/api/mock-foreman?serial=${encodeURIComponent(serial)}`);
if (!res.ok) throw new Error('Mock foreman failed');
const data = await res.json();
return { mac: data.mac || '', ip: data.ip || '' };
} catch (e) {
return { mac: '', ip: '' };
}
}