# Releasing

The six `@opencitadel/*` packages share one version and are published together by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) with npm trusted publishing.
No npm token exists anywhere: npm verifies the workflow's GitHub OIDC token and adds a
provenance attestation to every version, linking it to the commit and workflow run.

## Cutting a release

```sh
node scripts/release.mjs 0.2.0      # bumps all six package.json files, commits, tags v0.2.0
git push --follow-tags
```

Pushing the tag runs the workflow:

1. **check:** build, unit tests, the end-to-end run, and a `npm publish --dry-run` of every
   package.
2. **publish** (only for `v*` tags, in the `npm` environment):
   1. Installs npm 11, which trusted publishing requires.
   2. Pins the internal `workspace:*` dependencies to the release version.
   3. Publishes in dependency order: protocol, gamefiles, plugin-sdk, master, host, client.

   A re-run skips versions that are already on the registry, so a partial failure is fixed by
   re-running the job.

To exercise everything except the publish, run the workflow by hand (Actions → Release → Run
workflow); only the check job runs.

## How it's wired

* **GitHub:** the `npm` environment only accepts deployments from `v*` tags. Add required
  reviewers under Settings → Environments → npm if you want a human to approve each release.
* **npm:** each package trusts `thomasreichmann/opencitadel`, workflow `release.yml`, environment
  `npm`, with direct publishing allowed.

  Both commands below need 2FA. Pass the code as `--otp=<code>`: `npm trust` treats a separate
  `--otp <code>` as a stray argument. One code covers all six packages if you run them together.

  To view the entries:

  ```sh
  npx npm@11 trust list @opencitadel/host --otp=<code>
  ```

  To recreate them:

  ```sh
  for p in protocol gamefiles plugin-sdk host master client; do
    npx npm@11 trust github @opencitadel/$p --file=release.yml --repo=thomasreichmann/opencitadel --env=npm --allow-publish --yes --otp=<code>
  done
  ```

  npm drops a new trusted publisher entry if it doesn't complete a publish within two days of
  being created.

## Manual publishing (fallback)

With an npm account that has 2FA on writes:

```sh
pnpm build
pnpm -r publish --access public --otp <code>
```

For a brand-new package, npm shows a public `0.0.0-stage` placeholder for a few minutes while it
processes the first version. That's expected.
