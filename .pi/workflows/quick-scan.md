---
name: quick-scan
description: Quick parallel codebase scan for common issues
---

## 1. Scan

| ID | Label | Prompt |
|----|-------|--------|
| scan-types | Scan Types | Find TypeScript type errors and unsafe type assertions in the codebase. Report file paths and line numbers. |
| scan-deps | Scan Dependencies | Check for outdated or vulnerable npm dependencies. Look at package.json and imports. |
| scan-secrets | Scan Secrets | Search for hardcoded secrets, API keys, or tokens accidentally committed to the codebase. |

## 2. Summarize

| ID | Label | Prompt |
|----|-------|--------|
| summarize | Summarize Findings | Create a single consolidated report from: Types: {phase.1.scan-types.output} Dependencies: {phase.1.scan-deps.output} Secrets: {phase.1.scan-secrets.output} |