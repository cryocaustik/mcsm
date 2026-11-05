# Modpack management integration

Policy selected by user: pin versions by default; expose an explicit follow-latest option.

Keep itzg/FTB responsible for installation, loader selection, cleanup and upgrade execution.
MCSM records requested configuration separately from installed evidence and adds metadata,
version discovery, update controls, file ownership and backup-backed recovery.

Verified upstream contracts (2026-11-04):
- itzg docker-minecraft-server commit 31ab4db856c68d95c7442fe9d04dc740fd939a37.
- itzg mc-image-helper commit 46420eeb83cef53296aecf3d60093cbc4ff43607.
- FTBTeam FTB-Server-Installer commit b9c23e875baa5107061a687e5c9f49e2a4f7443b.
- TYPE=AUTO_CURSEFORGE/FTBA/MODRINTH are supported aliases for MODPACK_PLATFORM.
- CurseForge writes /data/.curseforge-manifest.json: modId, fileId, slug,
  modpackName, modpackVersion, minecraftVersion, modLoaderId and files[].
  /data/.install-curseforge.env provides installer results. The manifest is
  written before the missing-download exception, so manifest presence alone
  cannot certify a successful install.
- Modrinth writes /data/.modrinth-modpack-manifest.json: projectSlug,
  versionId (provider version ID), dependencies and files[].
  /data/.install-modrinth.env provides pack name/version and runtime results.
  Do not confuse modrinth.index.json's versionId (pack label) with API version ID.
- FTB writes /data/.manifest.json: id, name, versionName, versionId,
  modPackTargets and files[]. Each file has path/name/url/hash/hash_type.
  /data/.ftb-installed is packID=versionID, written after installer success.
- CF/Modrinth installed manifests list managed paths, not per-JAR hashes or
  provider identities. FTB includes hashes. Paths establish installer ownership;
  they do not establish current content identity. Reuse our verified signature cache.
- Public FTB API confirmed: /v1/modpacks/public/modpack/{id} and /{id}/{versionId}
  on api.feed-the-beast.com. Versions include IDs, names, channels and timestamps.

Implementation boundaries:
- Pack-owned JARs are managed as a unit; individual update/delete/overwrite is
  blocked in the API as well as hidden in the UI. Download/export remain available.
- Custom additions retain independent acquisition records and management.
- Never relabel all files according to server type or infer ownership from filenames.
- Installed Minecraft/loader metadata drives compatibility. Invalidate the loader
  cache when packs change; the current lifetime-cache assumption is incorrect.
- Keep follow-latest behavior for existing unpinned configurations until a user
  changes it. New configurations resolve and persist an exact version ID by default.
- Update: validate exact target -> stop -> full-volume backup -> save prior config
  and backup reference -> recreate with new pin -> observe installation/readiness.
  Container.start() does not mean the Minecraft server is ready.
- Rollback needs both the volume backup and old container configuration; backups
  include the data volume, while MCSM configuration lives in Docker labels.
- Reuse content identities across updates; reverify changed filesystem revisions.
- Catalog outages must preserve installed visibility. Unknown/malformed installer
  state must be visible, and must not silently permit edits to pack-managed files.

Local research checkouts are in /tmp/mcsm-itzg-modpack-research,
/tmp/mcsm-image-helper-research and /tmp/mcsm-ftb-installer-research.
