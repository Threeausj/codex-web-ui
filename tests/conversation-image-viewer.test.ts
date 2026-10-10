import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationImageUrl, createConversationImageViewer, safeConversationImageSource } from '../src/lib/conversation-image-viewer';

test('local image URLs preserve host and filename scope without opening another API route', () => {
  const url = conversationImageUrl('/workspace/研究 image #1.png', 'remote / 1');
  assert.equal(url, '/api/hosts/remote%20%2F%201/images?path=%2Fworkspace%2F%E7%A0%94%E7%A9%B6+image+%231.png');
  assert.equal(safeConversationImageSource(url, 'remote / 1'), true);
  assert.equal(safeConversationImageSource(url, 'another-host'), false);
  assert.equal(safeConversationImageSource('/api/hosts/local/resources?path=/image.png', 'local'), false);
  assert.equal(safeConversationImageSource('/api/hosts/local/images?path=/image.png&path=/other.png', 'local'), false);
  assert.equal(safeConversationImageSource('/api/hosts/local/images?path=', 'local'), false);
  assert.equal(safeConversationImageSource('/api/hosts/local/images?path=/image.png&other=1', 'local'), false);
});

test('previews accept existing web and inline images without proxying their URL', () => {
  for (const source of ['https://images.example/a.png', 'http://images.example/a.png', 'data:image/png;base64,AAAA', 'data:image/svg+xml,%3Csvg%3E', 'blob:https://codex.example/image-id']) {
    assert.equal(safeConversationImageSource(source, 'local', 'https://codex.example'), true, source);
  }
  for (const source of ['', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/image.png', '//images.example/a.png', '../image.png', 'https://images.example/\nimage.png', 'https://']) {
    assert.equal(safeConversationImageSource(source, 'local', 'https://codex.example'), false, source);
  }
  assert.equal(safeConversationImageSource('https://codex.example/api/hosts/other/images?path=/image.png', 'local', 'https://codex.example'), false);
  assert.equal(safeConversationImageSource('https://codex.example/api/hosts/local/images?path=/image.png', 'local', 'https://codex.example'), true);
  assert.equal(safeConversationImageSource('https://codex.example/api/auth/session', 'local', 'https://codex.example'), false);
});

test('opening a new image replaces the old preview, invalid input leaves it intact, and closure drops its private source', () => {
  const viewer = createConversationImageViewer();
  const first = { src: conversationImageUrl('/private/first.png', 'local'), name: 'first.png', hostId: 'local', threadId: 'thread-a' };
  assert.equal(viewer.open(first), true);
  assert.deepEqual(viewer.image.value, first);
  assert.equal(viewer.open({ src: '/api/hosts/other/images?path=/private.png', name: 'wrong host', hostId: 'local' }), false);
  assert.deepEqual(viewer.image.value, first);
  assert.equal(viewer.open({ src: 'https://images.example/second.png', name: '', hostId: 'remote', threadId: 'thread-b' }), true);
  assert.equal(viewer.image.value?.hostId, 'remote');
  assert.equal(viewer.image.value?.name, '图片');
  viewer.close();
  assert.equal(viewer.image.value, null);
});
