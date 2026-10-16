// The two fetches example/integration exercises, as example/lib/blogService.ts makes them.
const POSTS_URL = 'https://jsonplaceholder.typicode.com/posts?_limit=3';

export async function fetchPostsWithForceCache(): Promise<unknown[]> {
  const response = await fetch(POSTS_URL, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error('Failed to fetch posts');
  }
  return response.json();
}

export async function fetchPostsWithTags(): Promise<unknown[]> {
  const response = await fetch(POSTS_URL, {
    next: { revalidate: 300, tags: ['api-posts', 'external-data'] },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch posts');
  }
  return response.json();
}
