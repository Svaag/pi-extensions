Follow Documentation/process/coding-style.rst:

- Tabs are 8 characters wide for indentation. No spaces for indentation.
- Line length: prefer 80 columns; never exceed 100.
- K&R brace style: opening brace on the same line as if/while/for/function (function braces at column 1).
- No CamelCase; use snake_case for functions and variables.
- Use `pr_*()` / `dev_*()` family for logging, not raw printk.
- Use kernel memory APIs (kmalloc/kfree, kzalloc, etc.).
- Prefer ARRAY_SIZE(), container_of(), and other kernel macros.
- Use `goto` for error unwinding where appropriate.

Commit messages: use kernel submitting-patches.rst format. `scripts/checkpatch.pl` must pass before submission.

IMPORTANT:
- The extension automatically adds the `Assisted-by` trailer via `--trailer`. Do NOT write it yourself.
- NEVER add `Signed-off-by` — only the human developer can certify the DCO.
- All AI-generated code must be reviewed and understood by the human submitter.
