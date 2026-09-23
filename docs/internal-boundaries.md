# Maintainer review boundaries before a public switch

The repository still contains materials that look useful for maintainers but should be reviewed before changing repository visibility or publishing an official website/demo.

## Items that require manual review

### Internal deployment records

- Root-level `DEPLOY_RECORD_*.md`
- Historical verification notes under `docs/` such as backup manifests and server environment audits

These files may contain infrastructure addresses, local filesystem paths, operator procedures, or historical release details that are not appropriate for a public repository.

### Release hosting and upload helpers

- Root-level helper scripts such as `_upload*.mjs`, `_verify-*.mjs`, `_sha-*.mjs`, `_discover-*.mjs`, `_probe-*.mjs`
- Deployment helpers under `scripts/` and `deploy/`

These files should be checked for hard-coded hosts, packaging assumptions, or maintainer-only workflows before public exposure.

### Website and download assets

- `web/official.html`
- `web/download.html`
- install/download hosting assumptions referenced by website assets

These files should be reviewed together with any real public domain, TLS, package hosting, and demo plan.

### Mobile packaging notes

- `mobile-app/README.md`
- `app/README.md`

These docs may mix public packaging guidance with maintainer-specific build/distribution assumptions.

## Release rule of thumb

If a file contains a live infrastructure address, a private operator path, a release-hosting workflow, or a backup/deployment note, assume it needs maintainer review before public release unless it is intentionally part of the public product documentation.
