Follow a consistent C style:

- Prefer tabs or 4-space indentation — match existing code in the codebase.
- Braces: K&R style unless the project uses a different convention. Opening brace on same line as control statements; function braces at column 0 or same line as project convention.
- Use `snake_case` for functions, variables, and file names.
- `ALL_CAPS` for macros and constants.
- `typedef` sparingly; avoid `_t` suffix for POSIX compatibility.
- Use `const` where pointers/values don't change.
- Declare variables at the smallest scope. Initialize at declaration.
- Use `NULL` for pointers, `'\0'` for the null character.
- Explicit checks: `if (ptr == NULL)` not `if (!ptr)`.
- Free memory at the same scope level it was allocated.
- Header guards: `#ifndef PATH_TO_FILE_H` / `#define` / `#endif`.
