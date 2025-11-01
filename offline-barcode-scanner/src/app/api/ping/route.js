export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ ok: true, from: '/api/ping' }, { headers: { 'Cache-Control': 'no-store' } });
}
