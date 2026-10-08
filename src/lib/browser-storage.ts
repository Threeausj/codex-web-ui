/** Storage may be denied or full. Failed writes must not break the application
 * or replace the user's current-window draft with an older persisted value. */
export class ResilientStorage {
  private temporary = new Map<string, string | null>();
  constructor(private storage: () => Storage) {}
  getItem(key: string): string | null {
    if (this.temporary.has(key)) return this.temporary.get(key)!;
    try { return this.storage().getItem(key); } catch { return null; }
  }
  setItem(key: string, value: string): boolean {
    this.temporary.set(key, value);
    try { this.storage().setItem(key, value); this.temporary.delete(key); return true; }
    catch { return false; }
  }
  removeItem(key: string): boolean {
    this.temporary.set(key, null);
    try { this.storage().removeItem(key); this.temporary.delete(key); return true; }
    catch { return false; }
  }
  isTemporary(key: string) { return this.temporary.has(key); }
}

export const browserStorage = {
  local: new ResilientStorage(() => localStorage),
  session: new ResilientStorage(() => sessionStorage),
};
