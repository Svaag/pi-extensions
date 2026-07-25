Follow Rust API guidelines and standard conventions:

- Run `cargo fmt` and `cargo clippy` before committing. Clippy must be clean with no warnings.
- Use `rustfmt` with default settings (or the project's `rustfmt.toml`).
- Prefer `Result` and `Option` over panicking. Reserve `unwrap()` / `expect()` for invariants.
- Use `?` operator for error propagation.
- Derive common traits (`Debug`, `Clone`, `PartialEq`, `Eq`) where appropriate.
- Use `impl Trait` in argument position and return position where it improves clarity.
- Prefer `&str` over `&String` in function arguments.
- Follow module and visibility conventions. Keep public API surface minimal.
- Write doc comments (`///`) for public items. Use `//!` for module-level docs.
- Use `#[must_use]` on functions where ignoring the return value is likely a bug.
- Test with `#[cfg(test)]` modules. Include both unit and integration tests.
