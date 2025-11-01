export async function GET(request) {
const { searchParams } = new URL(request.url);
const serial = searchParams.get('serial') || '';
const seed = serial.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
const rand = (n) => (seed * 9301 + 49297) % n;
const mac = `02:00:${(rand(255)).toString(16).padStart(2, '0')}:${(rand(255)).toString(16).padStart(2, '0')}:${(rand(255)).toString(16).padStart(2, '0')}:${(rand(255)).toString(16).padStart(2, '0')}`;
const ip = `10.${(seed % 255)}.${(seed % 200)}.${(seed % 240)}`;
return Response.json({ serial, mac, ip });
}