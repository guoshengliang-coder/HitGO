# Verified releases

`make release v=X.Y.Z` pushes a tag. The tag starts the GitHub Actions Deploy
workflow. A successful workflow builds the image, checks the public API commit
and version, compares the public HTML and JavaScript with the running container,
and uploads `release-receipt.json`. A successful tag push by itself is **not** a
successful deployment.
The release command checks the required `prototype` secret and variable names
before creating a tag, so a known missing configuration fails early.

## One-time GitHub environment setup

In the `prototype` environment, set these secrets: `DEPLOY_SSH_KEY`,
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_APP_DIR`, and `DEPLOY_KNOWN_HOSTS`.
The last value must contain the target's verified SSH host key line. Set the environment variable
`HITGO_PUBLIC_ORIGIN` to the HTTPS origin users visit. Enter the real values in
GitHub settings, never in tracked files. The workflow sets `SKIP_SMOKE=1`; the
render smoke currently modifies real user data and must stay disabled until
that script is repaired.

The deployment account must be able to connect over SSH, sync the app directory,
and use passwordless `sudo docker compose`. Verify the SSH host key fingerprint
out of band before adding its line to CI trust settings.

## Local fallback

The local `.deploy.env` is ignored by Git and should set `HITGO_SSH` and
`HITGO_PUBLIC_ORIGIN`. Follow `.private/DEPLOYMENT-LOCAL.md` for the verified
target and access procedure. From a clean, tagged `main` checkout:

```sh
SKIP_SMOKE=1 make deploy
```

If CI configuration is temporarily unavailable and a local release has been
explicitly chosen, `RELEASE_MANUAL_DEPLOY=1 make release v=X.Y.Z` skips only
the CI configuration preflight. The tag-triggered workflow may then fail; the
local deploy and its public verification still have to succeed.

The last stdout line is a JSON release receipt when `HITGO_PUBLIC_ORIGIN` is
set. Keep that receipt outside the repository. If public verification fails,
the command exits nonzero; inspect the API version and public asset hashes
before retrying. Re-running the same commit can produce a verified receipt but
will not be eligible for automatic MissionGo matching because there is no new
source range.

## MissionGo notice preparation

Read `product.json.name`, match it uniquely against `list_products`, and fetch
every page of `list_release_candidates` for that product. Save the complete
candidate list and release receipt to temporary JSON files, then run:

```sh
node scripts/release-notices.mjs --receipt /tmp/hitgo-receipt.json --candidates /tmp/hitgo-candidates.json
```

The script only proposes comments. It checks each PR's repository, merged
state, merge commit within the actual online source range, and Web/Server file
changes. Before writing any proposal, follow the MissionGo Skill's full item
read, status, timeline, attachment, and idempotency checks. Do not write a
release notice when the receipt is absent or `eligibleForMatching` is false.

The old deployment script did not produce a receipt for v0.26.0. Its release
must not be treated as automatically matched by this new process.
