# x402 Wallet Extension

Built-in throwaway EVM wallet support for Pi plus an `x402_request` tool that can pay x402 HTTP APIs on Base USDC without exposing the private key to the model.

## Install

From this repository root:

```bash
npm install --prefix x402-wallet
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/x402-wallet" ~/.pi/agent/extensions/x402-wallet
```

Pi resolves npm modules from the extension path. If you copy only this directory somewhere else, run `npm install` inside the copied `x402-wallet/` directory instead.

Reload Pi with `/reload`.

The extension publishes its bundled `SKILL.md` automatically via `resources_discover`, so the `x402-wallet` skill is available when the extension is loaded.

## Wallet

Create a throwaway wallet:

```text
/x402-wallet create
```

Fund the shown address with only a small amount of Base USDC. The wallet file defaults to `~/.pi/agent/x402-wallet.json` with mode `0600`.

Environment private keys override the stored wallet:

- `X402_EVM_PRIVATE_KEY`
- `EVM_PRIVATE_KEY`

Do not use a main wallet.

## Configuration

- `X402_ALLOWED_NETWORKS` — comma-separated networks. Default: `eip155:8453,base`.
- `X402_ALLOWED_ASSETS` — comma-separated token contracts. Default: Base native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Use `*` only when you intentionally allow other assets.
- `X402_MAX_USDC` — per-call cap. Default: `5.00`.
- `X402_AUTO_APPROVE=1` — skip UI confirmation for non-interactive runs. Use only with a tight `X402_MAX_USDC`.
- `X402_WALLET_FILE` — override stored wallet path.
- `X402_BASE_RPC_URL` / `BASE_RPC_URL` — optional RPC for Base helper flows.

## Tools

- `x402_wallet_status` — shows address/config; never reveals private keys.
- `x402_request` — makes an HTTP request, handles x402 `402 Payment Required`, signs, and retries after approval.

Example tool intent:

```json
{
  "url": "https://api.example.com/v1/vm/create",
  "method": "POST",
  "json": { "quoteId": "q_..." },
  "maxUsdc": "1.40",
  "reason": "Provision approved staging VM"
}
```
