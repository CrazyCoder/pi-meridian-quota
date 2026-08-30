# Pi Meridian Quota

A [Pi](https://pi.dev) extension that displays [Meridian](https://github.com/rynfar/meridian) Claude subscription usage in the footer.

```text
Meridian 5h ██░░░░░░ 24% ⟳ 3h 7d ██████░░ 71% ⟳ 2d
```

The extension reads Meridian's `GET /v1/usage/quota` endpoint. It activates only when the selected Pi model resolves the `x-meridian-agent` header, so other providers and direct Anthropic OAuth sessions are not affected.

## Requirements

- Pi 0.84.1 or newer
- Meridian 1.40.0 or newer
- A Pi Anthropic provider override that routes through Meridian

## Install

Install the extension as a user-wide Pi Git package:

```bash
pi install npm:@jetserge/pi-meridian-quota
```

Restart Pi after installation. To update it later:

```bash
pi update --extensions
```

To remove it:

```bash
pi remove npm:@jetserge/pi-meridian-quota
```

## Configure Pi for Meridian

Add a provider override to `~/.pi/agent/models.json`. Replace the base URL with your Meridian server:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://localhost:3456",
      "apiKey": "x",
      "headers": {
        "x-meridian-agent": "pi"
      }
    }
  }
}
```

The API key is a non-empty placeholder. Meridian uses its own Claude authentication.

Do not log in to Anthropic through Pi while using this override. A Pi OAuth credential takes precedence over the API-key provider configuration and bypasses Meridian. If necessary, run `/logout`, select the Anthropic model again, and restart Pi.

## Usage

The footer refreshes at startup, after model changes, and every three minutes. It shows the five-hour and seven-day utilization windows with reset countdowns.

Run this command inside Pi to refresh immediately and show any connection or response error:

```text
/meridian-quota
```

The extension sends only `GET /v1/usage/quota` to the selected model's configured Meridian base URL. It forwards the resolved `x-meridian-agent` header and does not send the configured API key.

## Credits and other quota providers

This extension was inspired by
[pi-usage-bars](https://github.com/hknet/pi-usage-bars). If you do not use
Meridian and want the same type of quota display for other supported providers
and subscriptions, use that package instead.

`pi-usage-bars` is based on and inspired by:

- [CodexBar](https://github.com/steipete/CodexBar)
- [rho usage-bars](https://github.com/mikeyobrien/rho/tree/main/extensions/usage-bars)
- [ajarellanod/pi-usage-bars](https://github.com/ajarellanod/pi-usage-bars)

## Development

```bash
bun install
bun run check
bun run verify:package
```

## License

[MIT](LICENSE)
