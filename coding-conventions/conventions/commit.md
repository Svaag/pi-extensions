Write commit messages following kernel submitting-patches style:

- Subject line: imperative mood, 72 characters or fewer. Use a subsystem: prefix for large projects.
- Blank line after the subject.
- Body wrapped at 72 columns, explaining *why* the change is needed — not just what it does. Include rationale, context, and any relevant references.
- Use markdown-style backticks for code, function names, and file paths in the body.
- Trailers at the end: Signed-off-by, Reviewed-by, Reported-by, Fixes:, etc.

ALWAYS: The extension automatically adds the `Assisted-by` trailer to every commit via `--trailer`. Never write your own `Assisted-by` line — the harness handles it.

NEVER add `Signed-off-by` — only the human developer can certify the DCO.
