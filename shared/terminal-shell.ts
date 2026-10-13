/** Start a real interactive shell with its own completion/history bindings.
 * `/bin/sh` is often dash, which has neither readline nor Tab completion.
 * Prefer an explicitly configured interactive shell, then an available bash.
 * The launcher is fixed text; no user input is interpolated into shell code.
 */
export const interactiveShellCommand = [
  "/bin/sh", "-c",
  'terminal_shell=${SHELL:-}; case "$terminal_shell" in */bash|*/zsh|*/fish|*/ksh) if [ -x "$terminal_shell" ]; then exec "$terminal_shell" -i; fi ;; esac; if command -v bash >/dev/null 2>&1; then exec bash -i; fi; if [ -n "$terminal_shell" ] && [ -x "$terminal_shell" ]; then exec "$terminal_shell" -i; fi; exec /bin/sh -i',
];
