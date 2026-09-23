# Public beta release checklist

Use this checklist before switching the repository or website assets to a broader public audience.

## Documentation and metadata

- [ ] Root `README.md` and `README.zh-CN.md` match the current repository scope
- [ ] `package.json`, `package-lock.json`, `version.txt`, `BUILD-INFO.json`, and `CHANGELOG.md` agree on the intended version
- [ ] Node/version requirements in docs match runtime code and CI
- [ ] Sandbox defaults in docs match `.env.example` and runtime behavior

## Governance

- [ ] `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, and `SUPPORT.md` are present and linked from the README
- [ ] Issue templates and PR template are enabled and review-ready

## Public-repo hygiene

- [ ] Review the files listed in [internal-boundaries.md](internal-boundaries.md)
- [ ] Remove or sanitize maintainer-only deployment notes, backup manifests, and release-hosting helpers that should not be public
- [ ] Scan changed files for secrets before release or tagging
- [ ] Confirm no hard-coded production-only infrastructure addresses remain in public-facing docs or website assets unless intentionally announced

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test` (if the changed area is covered)
- [ ] `python lingxi_engine/tests/run_all.py` (if the Python engine or its docs/config are affected)
- [ ] Review CI results on the intended release branch

## Manual deployment / domain steps

These steps still require maintainer action outside this repository:

- [ ] provision or confirm the public domain and TLS certificates
- [ ] review server/network exposure, reverse proxy config, and admin/auth defaults
- [ ] review website/download assets under `web/` before publishing them
- [ ] review/update install scripts and package hosting targets
- [ ] confirm public demo scope (if any) and keep it clearly separate from self-hosted guidance
