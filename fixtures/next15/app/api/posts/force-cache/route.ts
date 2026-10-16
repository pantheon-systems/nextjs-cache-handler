import { NextResponse } from 'next/server';
import { fetchPostsWithForceCache } from '../../../../lib/posts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startTime = Date.now();
  const posts = await fetchPostsWithForceCache();
  return NextResponse.json({
    data: posts,
    cache_strategy: 'force-cache',
    duration_ms: Date.now() - startTime,
    fetched_at: new Date().toISOString(),
  });
}
