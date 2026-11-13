import { proxyD1 } from '@/lib/d1/server-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ action: string }> };

async function handle(request: Request, context: Context): Promise<Response> {
  const { action } = await context.params;
  return proxyD1(request, action, {
    env: {
      D1_CUSTODY_SUPABASE_URL: process.env.D1_CUSTODY_SUPABASE_URL,
      D1_CUSTODY_ANON_KEY: process.env.D1_CUSTODY_ANON_KEY,
      D1_CUSTODY_NAMESPACE: process.env.D1_CUSTODY_NAMESPACE,
    },
    fetch: (...args) => fetch(...args),
  });
}

export { handle as GET, handle as POST };
// Explicit rejection also keeps unsupported-method responses non-cacheable.
export { handle as HEAD, handle as OPTIONS, handle as PUT, handle as PATCH, handle as DELETE };
