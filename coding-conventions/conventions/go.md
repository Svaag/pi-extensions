Follow standard Go conventions and Effective Go:

- Run `go fmt` (or `gofmt`) and `go vet` before committing.
- Use `gofmt` default formatting — no custom style.
- Idiomatic error handling: `if err != nil { return ... }`. Never ignore errors silently.
- Use short variable names in small scopes; descriptive names for public APIs.
- Exported identifiers are `PascalCase`; unexported are `camelCase`.
- Prefer composition over inheritance. Use interfaces sparingly and define them at the call site.
- Use `context.Context` as the first argument for functions that do I/O.
- Group imports: standard library, third-party, local — separated by blank lines.
- Run `go test ./...` before committing. Include table-driven tests.
- Keep package APIs small and focused. Avoid import cycles.
