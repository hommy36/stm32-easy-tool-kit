# Publishing

VS Code Marketplace and Open VSX are independent registries. Publishing to one does not update the other.

## VS Code Marketplace

Run **Publish Extension** (`publish.yml`) on the release commit. It uses the existing OIDC publisher association, so no Marketplace PAT is stored in the repository.

## Open VSX

The workflow supports Open VSX trusted publishing (OIDC) when the namespace owner has associated this repository and workflow. Otherwise configure a token:

1. Sign into [Open VSX](https://open-vsx.org/user-settings/tokens) with the account authorized to publish under `hommy36`, and create a publishing token.
2. Store it in [GitHub Actions repository secrets](https://github.com/hommy36/stm32-easy-tool-kit/settings/secrets/actions) as `OVSX_PAT`. Never commit the token or paste it in issue/chat logs.
3. Run **Publish Open VSX** (`publish-open-vsx.yml`) on the release commit. It installs locked dependencies, type-checks, packages the current version, and publishes that VSIX using a pinned Open VSX CLI. When `OVSX_PAT` is absent, the CLI attempts OIDC trusted publishing.
4. Confirm the workflow success and the version returned by `https://open-vsx.org/api/hommy36/stm32-easy-tool-kit/latest`. Registry and editor caches may update later.

Both workflows are manually dispatched. An existing version cannot be replaced; increment the version for code changes after publication. A credential or network failure may be retried only after checking whether the version was already published.
