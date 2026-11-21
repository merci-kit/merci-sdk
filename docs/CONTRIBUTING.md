# Contributing

This repository is a showcase. It is published so the SDK can be read,
installed and evaluated — not as a project that accepts patches.

- **Issues and pull requests are disabled.** Please do not open one; it will
  not be reviewed.
- **Forks are allowed by the licence.** Apache-2.0 lets you fork, modify and
  redistribute the code. A fork is your own project and is not affiliated with
  this one.
- **Security.** If you find a vulnerability, use GitHub's private
  vulnerability reporting on this repository rather than a public issue.

## Reading and running it locally

The repository is self-contained:

```bash
pnpm install
pnpm test              # the offline suite
pnpm run test:examples # the deterministic example audits
```

Architecture conventions live in [`GUIDELINES.md`](../GUIDELINES.md); the
module map is [`STRUCTURE.md`](../STRUCTURE.md).

## Licence

Apache-2.0 — see [`LICENSE`](../LICENSE). The name and logo are trademarks of
Lukáš Michna (Mobeetle); see [`TRADEMARK.md`](../TRADEMARK.md).
