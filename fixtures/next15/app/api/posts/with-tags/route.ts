import { NextResponse } from 'next/server';
import { fetchPostsWithTags } from '../../../../lib/posts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startTime = Date.now();
  const posts = await fetchPostsWithTags();
  return NextResponse.json({
    data: posts,
    cache_strategy: 'tags-revalidate-5m',
    duration_ms: Date.now() - startTime,
    fetched_at: new Date().toISOString(),
    cache_tags: ['api-posts', 'external-data'],
  });
}
