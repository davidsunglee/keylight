# Wide table

More columns than a phone is wide. The table scrolls inside its own box; the page does not.

| Gate | Command | Tool | Scope | Runner | Offline | Required | Threshold | Exempt paths | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Types | `bun run gate:types` | TypeScript | All TypeScript | Linux | Yes | Yes | No errors | None | Strict, with unchecked index access |
| Lint | `bun run gate:lint` | Biome | Code and CSS | Linux | Yes | Yes | No findings | Markdown | Recommended rules, cognitive complexity at 15 |
| Tests | `bun run gate:tests` | Bun | Production modules | Linux | Yes | Yes | 90% lines and functions | `**/test/**`, `checks/` | Per loaded file |
| Duplication | `bun run gate:duplication` | jscpd | Production code | Linux | Yes | Yes | Fixed percentage | `**/test/**` | Measured once, then locked |
| Browser | `bun run check:browser` | Playwright WebKit | Viewer fixtures | macOS | Yes | Yes | No issues | None | Desktop and iPhone 15 |
