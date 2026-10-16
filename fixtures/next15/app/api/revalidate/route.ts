import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

// Next.js 15 signature: revalidateTag(tag) with no cacheLife profile.
export async function GET(request: NextRequest) {
  const tag = new URL(request.url).searchParams.get('tag');
  if (!tag) {
    return NextResponse.json({ error: 'Cache tag is required. Use ?tag=your-tag-name' }, { status: 400 });
  }

  revalidateTag(tag);

  return NextResponse.json({
    message: `Cache tag '${tag}' has been revalidated`,
    revalidated_at: new Date().toISOString(),
    tag,
  });
}
