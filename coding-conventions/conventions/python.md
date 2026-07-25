Follow PEP 8 and modern Python best practices:

- Run `ruff` (or `flake8` / `black`) before committing. Code must pass linting cleanly.
- Use 4 spaces for indentation. No tabs.
- Line length: 88 characters (Black default) or 79 (strict PEP 8) — follow the project's pyproject.toml.
- Use type hints on all public functions and methods.
- Prefer `pathlib` over `os.path`. Prefer f-strings over `.format()` and `%`.
- Use `def` for functions, `class` for classes. Follow `snake_case` for functions/variables, `PascalCase` for classes.
- Use context managers (`with`) for resource management.
- Handle specific exceptions; never bare `except:`.
- Use `if __name__ == "__main__":` guard for script entry points.
- Write docstrings for public modules, classes, and functions (Google or NumPy style).
- Run `pytest` before committing. Include tests for new features and bug fixes.
