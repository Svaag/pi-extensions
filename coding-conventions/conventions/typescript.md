Follow standard TypeScript conventions:

- Run the project's linter (ESLint / Biome) and formatter (Prettier / Biome) before committing.
- Use strict TypeScript: `strict: true` in tsconfig, no implicit `any`.
- Prefer `const` over `let`; avoid `var`.
- Use `async/await` over raw promises. Handle promise rejections.
- Prefer arrow functions for callbacks; `function` for top-level declarations.
- Use explicit return types on exported functions.
- Use `camelCase` for variables and functions; `PascalCase` for classes and React components.
- Single-file exports: prefer named exports over default exports (tree-shaking).
- Write JSDoc comments for public API surfaces. Use TSDoc syntax.
- Keep imports organized and avoid circular dependencies.
- Run `npm test` (or `vitest` / `jest`) before committing. Tests must pass.
