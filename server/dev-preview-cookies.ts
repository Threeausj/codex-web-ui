type Cookie = { name: string; value: string; path: string; expires: number }

/** Cookies belong to one preview capability, never to the Codex browser origin. */
export class PreviewCookies {
  private values = new Map<string, Cookie>()

  receive(headers: string[] | undefined, requestPath: string, now = Date.now()) {
    for (const header of (headers || []).slice(0, 128)) {
      if (header.length > 4096) continue
      const [pair, ...attributes] = header.split(';')
      const equal = pair!.indexOf('=')
      if (equal <= 0) continue
      const name = pair!.slice(0, equal).trim(), value = pair!.slice(equal + 1).trim()
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue
      const pathOnly = requestPath.split('?')[0] || '/'
      let path = pathOnly.slice(0, pathOnly.lastIndexOf('/')) || '/', expires = Infinity, age: number | undefined, allowed = true
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.trim().split('=')
        const field = rest.join('=').trim()
        switch (key!.toLowerCase()) {
          case 'domain': if (!['localhost', '127.0.0.1', '::1'].includes(field.toLowerCase().replace(/^\./, ''))) allowed = false; break
          case 'path': if (field.startsWith('/')) path = field; break
          case 'max-age': if (/^-?\d+$/.test(field)) age = Number(field); break
          case 'expires': { const date = Date.parse(field); if (Number.isFinite(date)) expires = date; break }
        }
      }
      if (!allowed) continue
      if (age !== undefined) expires = now + Math.max(0, age) * 1000
      const id = `${path}\0${name}`
      if (expires <= now) this.values.delete(id)
      else { this.values.delete(id); this.values.set(id, { name, value, path, expires }) }
      while (this.values.size > 128) this.values.delete(this.values.keys().next().value!)
    }
  }

  header(requestPath: string, now = Date.now()) {
    const path = requestPath.split('?')[0] || '/'
    const matched: Cookie[] = []
    for (const [id, cookie] of this.values) {
      if (cookie.expires <= now) { this.values.delete(id); continue }
      if (path === cookie.path || path.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/')) matched.push(cookie)
    }
    return matched.sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }
}
