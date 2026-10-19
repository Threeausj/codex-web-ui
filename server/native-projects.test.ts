import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { NativeProjects, nativeProjectsUnsupported } from './native-projects.js'
import { RpcFailure, type Transport } from './bridge.js'
import { createServer } from './app.js'
import type { Project, RpcMessage } from './types.js'

const project: Project = { id: 'web-fixture', hostId: 'nas', path: '/workspace', rootPaths: ['/workspace', '/docs'], name: 'NAS', source: 'web' }
const entry = (id: string, name = 'NAS', roots = ['/workspace', '/docs']) => ({ id, name, roots: roots.map(path => ({ path })) })
function fixture(reply: (method: string, params: any) => unknown | Promise<unknown>, projects = [project]) {
  const calls: { hostId: string; method: string; params: any; timeout: number }[] = []
  const native = new NativeProjects({
    storage: { host: id => ['nas', 'other'].includes(id) ? { id, name: id, kind: 'ssh' } : undefined, projects: async () => projects },
    getBridge: async hostId => ({ request: async (method, params, timeout = 0) => {
      calls.push({ hostId, method, params, timeout })
      return reply(method, params)
    } }),
  })
  return { native, calls, projects }
}

test('native project resolution validates exact saved host and path before any RPC', async () => {
  const f = fixture(() => { throw new Error('Must not connect') })
  for (const [hostId, directory] of [['missing', '/workspace'], ['other', '/workspace'], ['nas', '/workspace/child'], ['nas', '/workspace/']])
    await assert.rejects(f.native.resolve(hostId!, directory!), (cause: any) => cause.status === 404)
  assert.equal(f.calls.length, 0)
})
test('read-only bindings discover native identities across pages without creating projects', async () => {
  const other = { ...project, id: 'b', name: 'Other', path: '/other', rootPaths: ['/other'] };
  const f = fixture((_method, params) => params.cursor
    ? { data: [entry('native-b', 'Other', ['/other'])], nextCursor: null }
    : { data: [entry('native-a')], nextCursor: 'second' }, [project, other]);
  assert.deepEqual(await f.native.bindings('nas'), { supported: true, bindings: [
    { path: '/workspace', projectId: 'native-a' }, { path: '/other', projectId: 'native-b' },
  ] });
  assert.ok(f.calls.every(call => call.method === 'project/list'));
  await assert.rejects(f.native.bindings('missing'), (error: any) => error.status === 404);
});
test('read-only bindings leave unmatched or ambiguous saved projects unresolved', async () => {
  const f = fixture(() => ({ data: [entry('first', 'Different'), entry('second', 'Another')], nextCursor: null }));
  assert.deepEqual(await f.native.bindings('nas'), { supported: true, bindings: [] });
  assert.equal(f.calls.length, 1);
});
test('read-only bindings fall back only for explicitly unsupported methods', async () => {
  const old = fixture(() => { throw new RpcFailure({ code: -32601, message: 'Method not found' }); });
  assert.deepEqual(await old.native.bindings('nas'), { supported: false, bindings: [] });
  const failed = fixture(() => { throw new Error('Connection timed out'); });
  await assert.rejects(failed.native.bindings('nas'), /timed out/);
});
test('read-only bindings cannot reuse an older project configuration while its native read is pending', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const f = fixture(async () => {
    if (++reads === 1) await gate;
    return { data: [entry('old-native'), entry('new-native', 'NAS', ['/workspace', '/new-docs'])], nextCursor: null };
  });
  const first = f.native.bindings('nas');
  await new Promise<void>(resolve => setImmediate(resolve));
  f.projects[0] = { ...project, rootPaths: ['/workspace', '/new-docs'] };
  const second = f.native.bindings('nas');
  await new Promise<void>(resolve => setImmediate(resolve));
  release();
  assert.deepEqual((await second).bindings, [{ path: '/workspace', projectId: 'new-native' }]);
  assert.deepEqual((await first).bindings, [{ path: '/workspace', projectId: 'old-native' }]);
  assert.equal(reads, 2);
});

test('automation cwd resolution prefers a primary project over another project secondary root', async () => {
  const docs = { ...project, id: 'web-docs', path: '/docs', rootPaths: ['/docs'], name: 'Docs' }
  const f = fixture(() => ({ data: [entry('nas-native'), entry('docs-native', 'Docs', ['/docs'])], nextCursor: null }), [project, docs])
  assert.deepEqual(await f.native.resolveForCwd('nas', '/docs'), { projectId: 'docs-native', supported: true })
  assert.equal(f.calls.length, 1)
})

test('automation cwd resolution accepts one secondary root and keeps other hosts isolated', async () => {
  const elsewhere = { ...project, hostId: 'other', id: 'other-project', path: '/elsewhere', rootPaths: ['/elsewhere', '/docs'] }
  const f = fixture(() => ({ data: [entry('nas-native')], nextCursor: null }), [project, elsewhere])
  assert.deepEqual(await f.native.resolveForCwd('nas', '/docs'), { projectId: 'nas-native', supported: true })
  assert.deepEqual(f.calls.map(call => call.hostId), ['nas'])
  await assert.rejects(f.native.resolve('nas', '/docs'), (cause: any) => cause.status === 404,
    'the public resolver still requires the exact saved primary project path')
})

test('automation cwd resolution rejects ambiguous secondary roots before connecting', async () => {
  const otherProject = { ...project, id: 'another-project', path: '/another', rootPaths: ['/another', '/docs'] }
  const f = fixture(() => { throw new Error('Must not connect') }, [project, otherProject])
  await assert.rejects(f.native.resolveForCwd('nas', '/docs'), (cause: any) => cause.status === 409 && /多个项目/.test(cause.message))
  assert.equal(f.calls.length, 0)
})

test('automation cwd resolution leaves unsaved directories and root descendants unassigned', async () => {
  const f = fixture(() => { throw new Error('Must not connect') })
  assert.equal(await f.native.resolveForCwd('nas', '/unsaved'), null)
  assert.equal(await f.native.resolveForCwd('nas', '/docs/child'), null)
  assert.equal(await f.native.resolveForCwd('other', '/workspace'), null)
  await assert.rejects(f.native.resolveForCwd('missing', '/workspace'), (cause: any) => cause.status === 404)
  assert.equal(f.calls.length, 0)
})

test('native project resolution walks all pages and compares normalized complete root sets', async () => {
  const f = fixture((_method, params) => params.cursor
    ? { data: [entry('correct', 'Desktop name', ['/docs/', '/workspace/./', '/docs'])], nextCursor: null }
    : { data: [entry('wrong-parent', 'NAS', ['/']), entry('wrong-subtree', 'NAS', ['/workspace/child', '/docs'])], nextCursor: 'page-2' })
  assert.deepEqual(await f.native.resolve('nas', '/workspace'), { projectId: 'correct', supported: true })
  assert.deepEqual(f.calls.map(call => call.params), [{ limit: 100 }, { limit: 100, cursor: 'page-2' }])
  assert.ok(f.calls.every(call => call.hostId === 'nas' && call.timeout > 0 && call.timeout <= 15000))
})

test('identical native roots use only a unique exact name to disambiguate', async () => {
  const f = fixture(() => ({ data: [entry('other-name', 'Other'), entry('same-name', 'NAS')], nextCursor: null }))
  assert.deepEqual(await f.native.resolve('nas', '/workspace'), { projectId: 'same-name', supported: true })
  for (const data of [[entry('one', 'Other'), entry('two', 'Another')], [entry('one'), entry('two')]]) {
    const ambiguous = fixture(() => ({ data, nextCursor: null }))
    await assert.rejects(ambiguous.native.resolve('nas', '/workspace'), (cause: any) => cause.status === 409 && /多个 Codex 项目/.test(cause.message))
    assert.equal(ambiguous.calls.length, 1)
  }
})

test('concurrent creation is coalesced and uses a stable key with the primary root first', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture(async (method, params) => {
    if (method === 'project/list') { await gate; return { data: [], nextCursor: null } }
    return { project: entry('created', params.name, params.roots.map((root: any) => root.path)) }
  })
  const first = f.native.resolve('nas', '/workspace')
  const second = f.native.resolve('nas', '/workspace')
  release()
  assert.deepEqual(await Promise.all([first, second]), [{ projectId: 'created', supported: true }, { projectId: 'created', supported: true }])
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1]!.method, 'project/create')
  assert.deepEqual(f.calls[1]!.params.roots, [{ path: '/workspace' }, { path: '/docs' }])
  assert.match(f.calls[1]!.params.idempotencyKey, /^codex-web-project:[a-f0-9]{64}$/)
  await f.native.resolve('nas', '/workspace')
  assert.equal(f.calls.length, 4, 'a later resolution must re-read desktop metadata')
  assert.equal(f.calls[3]!.params.idempotencyKey, f.calls[1]!.params.idempotencyKey)
})

test('successful resolutions are not cached across native project edits or host scopes', async () => {
  let revision = 'before'
  const f = fixture(() => ({ data: [entry(revision)], nextCursor: null }), [project, { ...project, hostId: 'other' }])
  assert.equal((await f.native.resolve('nas', '/workspace')).projectId, 'before')
  revision = 'after'
  assert.equal((await f.native.resolve('nas', '/workspace')).projectId, 'after')
  await f.native.resolve('other', '/workspace')
  assert.deepEqual(f.calls.map(call => call.hostId), ['nas', 'nas', 'other'])
})

test('only explicit unsupported-method failures fall back to cwd-only operation', async () => {
  for (const cause of [new RpcFailure({ code: -32601, message: 'Method not found' }), new Error('Unsupported method project/list'), new Error('Method project/list is not supported')]) {
    assert.equal(nativeProjectsUnsupported(cause), true)
    const f = fixture(() => { throw cause })
    assert.deepEqual(await f.native.resolve('nas', '/workspace'), { projectId: null, supported: false })
  }
  for (const cause of [new Error('Connection closed'), new Error('App-server request timed out: project/list'), new RpcFailure({ code: -32602, message: 'Invalid params' }), new Error('Unsupported project folder'), new Error('Permission denied')]) {
    assert.equal(nativeProjectsUnsupported(cause), false)
    const f = fixture(() => { throw cause })
    await assert.rejects(f.native.resolve('nas', '/workspace'), cause)
    assert.equal(f.calls.length, 1)
  }
})

test('older official CLI unknown request variants fall back only for the exact requested project method', async () => {
  const unknown = (method: string, code = -32600) => new RpcFailure({ code,
    message: `Invalid request: unknown variant \`${method}\`, expected one of \`initialize\`, \`thread/start\`, \`thread/list\`` })
  assert.equal(nativeProjectsUnsupported(unknown('project/list'), 'project/list'), true)
  assert.equal(nativeProjectsUnsupported(unknown('project/list'), 'project/create'), false)
  assert.equal(nativeProjectsUnsupported(unknown('project/list')), false)
  for (const cause of [unknown('sortKey'), unknown('thread/list'), unknown('project/list', -32602),
    new RpcFailure({ code: -32600, message: 'Invalid request: missing field `project/list`' })]) {
    assert.equal(nativeProjectsUnsupported(cause, 'project/list'), false)
    const f = fixture(() => { throw cause })
    await assert.rejects(f.native.resolve('nas', '/workspace'), cause)
  }
  const legacy = fixture(() => { throw unknown('project/list') })
  assert.deepEqual(await legacy.native.resolve('nas', '/workspace'), { projectId: null, supported: false })
  assert.equal(legacy.calls.length, 1)
  const legacyCreate = fixture(method => {
    if (method === 'project/list') return { data: [], nextCursor: null }
    throw unknown('project/create')
  })
  assert.deepEqual(await legacyCreate.native.resolve('nas', '/workspace'), { projectId: null, supported: false })
  assert.deepEqual(legacyCreate.calls.map(call => call.method), ['project/list', 'project/create'])
  const unrelatedCreateError = fixture(method => {
    if (method === 'project/list') return { data: [], nextCursor: null }
    throw unknown('project/list')
  })
  await assert.rejects(unrelatedCreateError.native.resolve('nas', '/workspace'), /unknown variant `project\/list`/)
})

test('unsupported create falls back, whereas invalid or mismatched project responses fail closed', async () => {
  const old = fixture(method => {
    if (method === 'project/list') return { data: [], nextCursor: null }
    throw new RpcFailure({ code: -32601, message: 'Method not found' })
  })
  assert.deepEqual(await old.native.resolve('nas', '/workspace'), { projectId: null, supported: false })
  for (const response of [{}, { project: entry('wrong-roots', 'NAS', ['/other']) }]) {
    const invalid = fixture(method => method === 'project/list' ? { data: [], nextCursor: null } : response)
    await assert.rejects(invalid.native.resolve('nas', '/workspace'), /格式不兼容|目录与当前项目不一致/)
  }
})

test('malformed pages or repeated cursors cannot create projects from incomplete results', async () => {
  for (const response of [{ data: [] }, { data: [entry('bad', 'NAS', ['relative'])], nextCursor: null }, { data: [], nextCursor: 'same-cursor' }]) {
    const f = fixture(() => response)
    await assert.rejects(f.native.resolve('nas', '/workspace'), /格式不兼容|分页游标重复/)
    assert.ok(f.calls.every(call => call.method === 'project/list'))
  }
})

test('a failed resolution clears its in-flight entry so a later retry sees fresh projects', async () => {
  let fail = true
  const f = fixture(() => {
    if (fail) throw new Error('Connection closed')
    return { data: [entry('recovered')], nextCursor: null }
  })
  await assert.rejects(f.native.resolve('nas', '/workspace'), /Connection closed/)
  fail = false
  assert.equal((await f.native.resolve('nas', '/workspace')).projectId, 'recovered')
  assert.equal(f.calls.length, 2)
})

function transport(hostId: string, calls: { hostId: string; method: string }[]): Transport {
  const input = new PassThrough(), output = new PassThrough()
  let buffer = ''
  input.on('data', chunk => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)) as RpcMessage
      buffer = buffer.slice(end + 1)
      if (message.id === undefined) continue
      calls.push({ hostId, method: message.method! })
      const result = message.method === 'initialize' ? { userAgent: 'native-project-fixture' }
        : message.method === 'project/list' ? { data: [entry('native-nas', 'NAS', ['/workspace'])], nextCursor: null } : {}
      queueMicrotask(() => output.write(JSON.stringify({ id: message.id, result }) + '\n'))
    }
  })
  return { input, output, events: new EventEmitter(), dispose: () => { input.destroy(); output.destroy() } }
}

test('native project HTTP resolution requires auth, CSRF and a saved project on the requested host', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-project-api-'))
  const calls: { hostId: string; method: string }[] = []
  const application = await createServer({ cwd: directory, codexHome: path.join(directory, 'codex'), dataDir: path.join(directory, 'web'),
    password: 'native-project-fixture-password', secureCookie: false, serveStatic: false,
    bridgeOptions: { mode: 'spawn', transportFactory: host => transport(host.id, calls) },
  })
  try {
    await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(application.server.address() as { port: number }).port}`
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'native-project-fixture-password' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const { csrfToken } = await login.json() as { csrfToken: string }
    const remote = await application.storage.addHost({ name: 'NAS', hostname: 'fixture.invalid' })
    await application.storage.addProject(remote.id, '/workspace', 'NAS')
    const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }
    const request = (body: unknown, customHeaders: Record<string, string> = headers) => fetch(base + '/api/projects/resolve-native', { method: 'POST', headers: customHeaders, body: JSON.stringify(body) })
    assert.equal((await request({ hostId: remote.id, path: '/workspace' }, { 'content-type': 'application/json' })).status, 401)
    assert.equal((await request({ hostId: remote.id, path: '/workspace' }, { 'content-type': 'application/json', cookie })).status, 403)
    for (const body of [{ hostId: 'missing', path: '/workspace' }, { hostId: 'local', path: '/workspace' }, { hostId: remote.id, path: '/other' }])
      assert.equal((await request(body)).status, 404)
    for (const body of [{ hostId: remote.id, path: 'relative' }, { hostId: remote.id, path: '/workspace', projectId: 'untrusted-id' }])
      assert.equal((await request(body)).status, 400)
    assert.equal(calls.length, 0)
    const result = await request({ hostId: remote.id, path: '/workspace' })
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { projectId: 'native-nas', supported: true })
    assert.ok(calls.every(call => call.hostId === remote.id))
    assert.equal(calls.filter(call => call.method === 'project/list').length, 1)
  } finally { await application.close(); await fs.rm(directory, { recursive: true, force: true }) }
})
