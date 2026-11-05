# Git branch workflows

Remotes: fork `origin`, original repository `upstream`. Main branch: `main`.
Feature branch: `multi-prov-mod-management`.

This guide stays local and untracked. These commands are reference instructions;
creating the guide does not run either workflow.

## Safety rules

- Do not hard-reset a user feature branch without confirmation.
- Do not force-push without confirmation.
- Do not delete branches without confirmation.
- Do not replace the original feature branch with a clean branch without confirmation.
- Do not continue after merge or cherry-pick conflicts without reviewing the resolution.
- Creating backups, fetching, checking status, and creating local upstream branches are okay.
- If a backup name already exists, preserve it and append a timestamp to the new
  name, for example `-$(date +%Y%m%d-%H%M%S)`.
- If work was stashed, keep the stash until it can be restored on the intended
  branch and reviewed.

## Workflow A: Temporary Integration

Purpose: temporarily merge an upstream branch into the feature branch during
development.

Prompt shortcut:

> Run the temporary integration workflow. Merge upstream branch `feat/server-sidebar` into feature branch `multi-prov-mod-management`.

Check status and remotes:

```sh
git status --short
git branch --show-current
git remote -v
```

If dirty:

```sh
git stash push -u -m "wip before temporary integration"
```

Fetch the upstream branch and create its local counterpart:

```sh
git fetch upstream feat/server-sidebar
git switch -c feat/server-sidebar upstream/feat/server-sidebar
```

If the local upstream branch already exists, use this instead of creating it.
The reset discards local commits on `feat/server-sidebar`; confirm first if it
contains user feature work.

```sh
git switch feat/server-sidebar
git reset --hard upstream/feat/server-sidebar
```

Switch to the feature branch, create a backup, and merge. If the backup exists,
append a timestamp to the backup name before running the backup command.

```sh
git switch multi-prov-mod-management
git branch backup/multi-prov-mod-management-before-feat-server-sidebar
git merge --no-ff feat/server-sidebar
```

If conflicts occur, inspect status, resolve the files, stage the resolution, and
review it before continuing:

```sh
git status
# Resolve files.
git add .
git diff --cached
# Continue only after reviewing the resolution.
git merge --continue
```

Or abort:

```sh
git merge --abort
```

Verify, then push:

```sh
git status
git log --oneline --graph --decorate -n 20
git push origin multi-prov-mod-management
```

## Workflow B: PR Cleanup

Purpose: rebuild the feature branch from latest `upstream/main`, preserving only
actual feature commits and dropping temporary integration merges.

Prompt shortcut:

> Run the PR cleanup workflow for feature branch `multi-prov-mod-management`.

Check status and remotes:

```sh
git status --short
git branch --show-current
git remote -v
```

If dirty:

```sh
git stash push -u -m "wip before PR cleanup"
```

Fetch both remotes:

```sh
git fetch upstream
git fetch origin
```

Update local and fork main. The reset discards local commits on `main`; preserve
any needed work first. If the push is rejected, review the divergence before
proceeding; a force-push requires confirmation.

```sh
git switch main
git reset --hard upstream/main
git push origin main
```

Back up the feature branch. If the backup exists, append a timestamp to the new
backup name.

```sh
git switch multi-prov-mod-management
git branch backup/multi-prov-mod-management-before-pr-cleanup
```

Identify actual feature commits:

```sh
git log --oneline --no-merges upstream/main..multi-prov-mod-management
git log --oneline --graph --decorate --all -n 50
```

Review each candidate: the list can include commits brought in by temporary
integration. Select only the intended feature commits, in oldest-to-newest
dependency order. Review integration merge resolutions for any feature changes
that also need preserving.

Create the clean branch. If the name already exists, review it and choose a new
name; do not overwrite or delete it without confirmation.

```sh
git switch -c multi-prov-mod-management-clean upstream/main
```

Cherry-pick selected feature commits, replacing the placeholders with hashes:

```sh
git cherry-pick COMMIT_HASH
```

Or pick multiple commits in order:

```sh
git cherry-pick COMMIT1 COMMIT2 COMMIT3
```

If conflicts occur, inspect status, resolve the files, stage the resolution, and
review it before continuing:

```sh
git status
# Resolve files.
git add .
git diff --cached
# Continue only after reviewing the resolution.
git cherry-pick --continue
```

Or abort:

```sh
git cherry-pick --abort
```

Verify the result:

```sh
git status
git diff upstream/main...HEAD
git log --oneline --graph --decorate -n 30
```

Only after explicit confirmation to replace the original feature branch:

```sh
git branch -M multi-prov-mod-management-clean multi-prov-mod-management
```

Only after explicit confirmation to force-push the cleaned branch:

```sh
git push --force-with-lease origin multi-prov-mod-management
```

## Local guide verification

```sh
ls -la .dev
git status --short
```

Expected status includes:

```text
?? .dev/
```

Keep `.dev/` out of the repository `.gitignore`. Only if the user requests hiding
it from local Git status, add it to the local exclude file:

```sh
echo ".dev/" >> .git/info/exclude
```
