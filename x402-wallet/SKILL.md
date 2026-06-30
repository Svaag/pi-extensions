---
name: x402-wallet
description: Built-in Ethereum/Base wallet workflow for paying x402 HTTP APIs with USDC. Use when a task is blocked by HTTP 402 Payment Required, x402, Base USDC, EVM_PRIVATE_KEY, paid API provisioning, or Hyrule VM provisioning.
---

# x402 Wallet

Use this skill when an API returns `402 Payment Required` with x402 requirements or when a workflow asks for a funded throwaway `EVM_PRIVATE_KEY` for Base USDC.

## Safety rules

- Never ask the user to paste a main wallet seed phrase or private key.
- Prefer the extension's built-in wallet tools over shell commands that need `EVM_PRIVATE_KEY`.
- Spend only after explicit user approval for a maximum amount, network, and purpose.
- Use the smallest approved `maxUsdc` for each paid call. If the user approved `$1.40`, pass `maxUsdc: "1.40"`.
- Do not reveal or log private keys or x402 payment headers.

## Tools

1. Call `x402_wallet_status` to see whether a built-in wallet is configured and to get its address for funding.
2. Use `x402_request` for paid HTTP calls. It:
   - makes the initial request,
   - parses x402 payment requirements from a `402` response,
   - enforces allowed networks and spend caps,
   - prompts for approval unless auto-approval is configured,
   - signs with the built-in wallet without exposing the key,
   - retries with the x402 payment header.
3. Use `x402_request` with `dryRun: true` when the price is unknown.

## Wallet setup

If `x402_wallet_status` says no wallet is configured, tell the user:

```text
Run /x402-wallet create, then fund the shown address with only the small amount of Base USDC you are willing to let Pi spend.
```

The extension can also use `X402_EVM_PRIVATE_KEY` or `EVM_PRIVATE_KEY` if the user intentionally configured a throwaway wallet in the Pi process environment.

Useful environment controls:

- `X402_ALLOWED_NETWORKS` defaults to `eip155:8453,base`.
- `X402_ALLOWED_ASSETS` defaults to Base native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Use `*` only for deliberately broader wallets.
- `X402_MAX_USDC` defaults to `5.00` and caps every tool call.
- `X402_AUTO_APPROVE=1` allows non-interactive spending up to `X402_MAX_USDC`.
- `X402_WALLET_FILE` changes the stored wallet path.

## Paid request workflow

When the user has already approved a specific spend:

1. Call `x402_wallet_status` if wallet state is unknown.
2. Call `x402_request` with:
   - `url`: paid endpoint URL,
   - `method`: HTTP method,
   - `headers`: normal API headers,
   - `json` or `body`: request payload,
   - `maxUsdc`: exact approved amount,
   - `reason`: concise user-visible purpose.
3. After a successful response, continue the original workflow.
4. If the response body includes provisioning IDs or poll URLs, poll with normal tools or `x402_request` only if those endpoints also require payment.

## Hyrule VM example

For a blocker like:

- quote cost `$1.40 USDC`,
- quote ID `q_...`,
- Base network,
- need `POST /v1/vm/create`,

first ensure the user explicitly approved spending up to `$1.40` and the wallet is funded. Then use `x402_request` for the create call with `maxUsdc: "1.40"` and the VM create JSON payload (quote id, selected VM size/duration, SSH public key, etc.). After it returns success, poll until the VM is ready and continue SSH/deploy steps.
