import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '@babel/parser'
import { rewriteDevelopmentAssets } from './dev-preview-rewrite.js'

const base = '/api/dev-preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const rewrite = (source: string, type = 'application/javascript') => rewriteDevelopmentAssets(source, type, base, 5173)

test('development script rewriting preserves bundled regexes, route strings, comments, and templates', () => {
  const source = String.raw`const doubleQuote = /"/g; const root = '/'; const routes = [{path:"/inbox"}]; const html = '<img src="/logo.svg">'; /* import "/not-real.js" */` + ' const template = `/route/${root}`;'
  assert.doesNotThrow(() => parse(source, { sourceType: 'module' }))
  assert.equal(rewrite(source), source)
  const bundled = 'import "/entry.js";const re=/"/g;const routes=[{path:"/"}];'
  const transformed = rewrite(bundled)
  assert.doesNotThrow(() => parse(transformed, { sourceType: 'module' }))
  assert.equal(transformed, `import "${base}/entry.js";const re=/"/g;const routes=[{path:"/"}];`)
})

test('development scripts rewrite only static and literal dynamic module specifiers', () => {
  const source = `import '/side-effect.js'; import value from "/src/module.js"; export { value } from '/export.js'; export * from '/all.js'; import('/lazy.js', { with: { type: 'json' } }); import(variable); fetch('/api/message'); import './relative.js'; import '//cdn.example/app.js';` + ' import(`/template.js`); import(`/dynamic/${variable}`);'
  const transformed = rewrite(source)
  for (const asset of ['side-effect.js', 'src/module.js', 'export.js', 'all.js', 'lazy.js', 'template.js']) assert.ok(transformed.includes(`"${base}/${asset}"`))
  for (const untouched of ['import(variable)', 'import(`/dynamic/${variable}`)', "fetch('/api/message')", "import './relative.js'", "import '//cdn.example/app.js'"]) assert.ok(transformed.includes(untouched))
  assert.doesNotThrow(() => parse(transformed, { sourceType: 'module' }))
  assert.equal(rewrite(transformed), transformed)
})

test('development asset URLs support the target loopback port and leave other origins unchanged', () => {
  const source = `import "http://localhost:5173/main.js?x=1#module"; import "http://127.0.0.1:5173/other.js"; import "http://[::1]:5173/ipv6.js"; import "https://cdn.example/app.js"; import "http://localhost:3000/app.js"; import "http://user:pass@localhost:5173/app.js";`
  const transformed = rewrite(source)
  assert.ok(transformed.includes(`"${base}/main.js?x=1#module"`))
  assert.ok(transformed.includes(`"${base}/other.js"`))
  assert.ok(transformed.includes(`"${base}/ipv6.js"`))
  for (const untouched of ['https://cdn.example/app.js', 'http://localhost:3000/app.js', 'http://user:pass@localhost:5173/app.js']) assert.ok(transformed.includes(untouched))
})

test('development HTML rewrites URL attributes and inline modules without changing script text or comments', () => {
  const source = `<html><head><link href=/style.css rel="stylesheet"><script type="module" src="/main.js"></script><script type="module">import '/inline.js'; const re=/"/g; const route='/';</script><script>const html='<img src="/private.png">'; const route="/";</script><style>body{background:url(/background.svg)}</style></head><body><!-- <img src="/comment.png"> --><img src="http://localhost:5173/logo.svg" data-path="/unchanged"><a href="/inbox?x=1&amp;y=2">Inbox</a><textarea><img src="/text.png"></textarea></body></html>`
  const transformed = rewrite(source, 'text/html; charset=utf-8')
  assert.ok(transformed.includes(`href=${base}/style.css`))
  assert.ok(transformed.includes(`src="${base}/main.js"`))
  assert.ok(transformed.includes(`import "${base}/inline.js"; const re=/"/g; const route='/';`))
  assert.ok(transformed.includes(`const html='<img src="/private.png">'; const route="/";`))
  assert.ok(transformed.includes(`url(${base}/background.svg)`))
  assert.ok(transformed.includes(`src="${base}/logo.svg" data-path="/unchanged"`))
  assert.ok(transformed.includes(`href="${base}/inbox?x=1&amp;y=2"`))
  assert.ok(transformed.includes('<!-- <img src="/comment.png"> -->'))
  assert.ok(transformed.includes('<textarea><img src="/text.png"></textarea>'))
  assert.equal(rewrite(transformed, 'text/html'), transformed)
})

test('development HTML handles srcset data URLs and inline CSS independently', () => {
  const source = `<img srcset="/small.png 1x, http://127.0.0.1:5173/large.png 2x, data:image/png;base64,AAAA 3x" style="background:url('/inline.svg')"><link imagesrcset='/first.png, /second.png 2x' href="//cdn.example/style.css">`
  const transformed = rewrite(source, 'text/html')
  assert.ok(transformed.includes(`srcset="${base}/small.png 1x, ${base}/large.png 2x, data:image/png;base64,AAAA 3x"`))
  assert.ok(transformed.includes(`style="background:url('${base}/inline.svg')"`))
  assert.ok(transformed.includes(`imagesrcset='${base}/first.png, ${base}/second.png 2x'`))
  assert.ok(transformed.includes('href="//cdn.example/style.css"'))
  assert.equal(rewrite(transformed, 'text/html'), transformed)
})

test('development CSS rewrites URL functions and imports while preserving comments and unrelated strings', () => {
  const source = `/* url(/comment.svg) */ @import "/base.css" layer(base); @import url('/theme.css'); @import /* note */ 'http://localhost:5173/fonts.css'; body{background:url( /logo.svg );mask:url("/mask.svg");content:"url(/text.svg)";font-family:'/name';--name:'/'}`
  const transformed = rewrite(source, 'text/css')
  for (const asset of ['base.css', 'theme.css', 'fonts.css', 'logo.svg', 'mask.svg']) assert.ok(transformed.includes(`${base}/${asset}`))
  for (const untouched of ['/* url(/comment.svg) */', 'content:"url(/text.svg)"', "font-family:'/name'", "--name:'/'"]) assert.ok(transformed.includes(untouched))
  assert.equal(rewrite(transformed, 'text/css'), transformed)
})

test('development response rewriting preserves JSON and unsupported script syntax', () => {
  assert.equal(rewrite('{"route":"/inbox"}', 'application/json'), '{"route":"/inbox"}')
  assert.equal(rewrite('future syntax /"/; import "/module.js"'), 'future syntax /"/; import "/module.js"')
})

test('development asset URL normalization keeps dot segments inside the preview ticket', () => {
  const source = `import "/../entry.js"; import "${base}/../outside.js"; import "/%2e%2e/encoded.js?x=1#hash";`
  const transformed = rewrite(source)
  assert.ok(transformed.includes(`"${base}/entry.js"`))
  assert.ok(transformed.includes(`"${base}/api/dev-preview/outside.js"`))
  assert.ok(transformed.includes(`"${base}/encoded.js?x=1#hash"`))
  assert.equal(rewrite(transformed), transformed)
})
