import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tag } = body;

    if (!tag) {
      return NextResponse.json(
        { error: 'Cache tag is required' },
        { status: 400 }
      );
    }

    console.log(`[API] /api/revalidate - Revalidating cache tag: ${tag}`);

    // Revalidate the specified cache tag
    revalidateTag(tag, 'max');

    return NextResponse.json({
      message: `Cache tag '${tag}' has been revalidated`,
      revalidated_at: new Date().toISOString(),
      tag
    });

  } catch (error) {
    console.error('[API] /api/revalidate - Error:', error);

    return NextResponse.json(
      { error: 'Failed to revalidate cache' },
      { status: 500 }
    );
  }
}

// Also support GET method for easier testing
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const tag = url.searchParams.get('tag');

  if (!tag) {
    return NextResponse.json(
      {
        error: 'Cache tag is required. Use ?tag=your-tag-name',
        available_tags: ['api-posts', 'external-data']
      },
      { status: 400 }
    );
  }

  console.log(`[API] /api/revalidate - Revalidating cache tag: ${tag}`);

  try {
    revalidateTag(tag, 'max');

    return NextResponse.json({
      message: `Cache tag '${tag}' has been revalidated`,
      revalidated_at: new Date().toISOString(),
      tag
    });

  } catch (error) {
    console.error('[API] /api/revalidate - Error:', error);

    return NextResponse.json(
      { error: 'Failed to revalidate cache' },
      { status: 500 }
    );
  }
}