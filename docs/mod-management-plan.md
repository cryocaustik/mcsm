# Mod management implementation plan

Branch: `feat/mod-providers`, based on local `main`.

The Files tab will keep manual uploads and file management, with an installed
mods table and a separate **Download mods** browser inspired by Prism Launcher.
Paper continues to use plugin terminology. The existing NeoForge branch is
independent of this work; modpack loader detection still supports NeoForge.

## Review chunks

1. **Provider contracts and file identity** — shared project, version, inventory,
   and search types; provider-qualified project IDs; SHA-1 and CurseForge
   fingerprints; bounded, verified downloads. No database migration.
2. **Provider adapters and install service** — Modrinth and CurseForge search,
   compatibility checks, required dependencies, and installation through common
   API routes. Reuse the global CurseForge key, keep it server-side, and respect
   authors who disable third-party downloads. Keep legacy Modrinth routes for
   compatibility.
3. **Installed mods table** — icons, display names and filenames, installed
   versions, last modified, provider links, size, search, sorting, provider and
   update filters. Preserve upload, deletion, restart and Modrinth updates.
   Provider outages must leave the local file list usable.
4. **Download browser and duplicate checks** — explicit source selector,
   compatible results, sorting, pagination, external links, installed badges,
   and server-side duplicate guards. Match provider projects and identical
   files across sources. Do not guess identity from display names alone.
5. **Validation and documentation** — tests for adapters, fingerprints,
   dependencies, duplicate handling and downloads; type checking, lint and
   production build. Document configuration and detection limits.

## Acceptance checks

- Search and install from either provider on supported servers; required
  dependencies install once, with at most one server restart.
- CurseForge without a configured key gives a useful setup message and leaves
  Modrinth and local files usable.
- A second installation of an identified project is blocked even if the
  project has a different version or the client has stale inventory.
- Identical files published on both providers are recognized under both
  identities. Different builds from the other provider cannot reliably be
  linked without a trustworthy shared identifier; do not claim otherwise.
- Manual and unknown jars remain visible, searchable and removable.
- Filtering and sorting preserve selection correctly; selection never targets
  a file that was removed from the refreshed inventory.
- Source-switching and fast searches cannot show a previous request's results.
- Existing managed integrations and CurseForge modpack synchronization are
  explained and do not gain a manual update action.

## Follow-up work

Provider-wide update planning (including CurseForge), choosing specific release
channels/versions, enable/disable, dependency removal and modpack reconciliation
are separate changes. Existing Modrinth update functionality remains available.
Cross-provider equivalence between different artifacts needs additional metadata
and an explicit conflict-resolution design.

## Review map

The first implementation includes chunks 1–5. Review the shared types and
`server/utils/mods/{types,fingerprint,download}.ts` first, followed by the two
provider adapters and `install.ts`. Then review `inventory.ts` and the three
`/api/server/:id/mods` routes, and finally the `InstalledModsTable`, `ModBrowser`
and `Files` components. The old provider-specific browser component is replaced;
the existing Modrinth API routes remain available.

No schema migration or new package is required. Automated adapter tests use
fixture responses; a live CurseForge installation and browser walkthrough
remain deployment acceptance checks, requiring a configured key and a test server.

### CurseForge download failure investigation

A read-only live check reproduced a `302` from `edge.forgecdn.net` to
`mediafilez.forgecdn.net` for Fabric API on Minecraft 1.21.1. Rejecting all
redirects caused a generic 502. The downloader now validates each redirect
against the provider's HTTPS CDN allowlist, allows at most three redirects and
still verifies file size and SHA-1. The updated downloader successfully fetched
and verified that real file in memory, without writing to a server or restarting
one.

Installation failures now include a stable error code, failed stage, relevant
file/provider status, recovery hint and reference ID linked to a sanitized log
entry. The browser keeps this information visible after the toast disappears.

### Installation source and available listings

The table now separates **Mod source** (recorded acquisition of the current file)
from **Available on** (verified listings of identical bytes). Source values are
Modrinth, CurseForge, Manual upload and Unknown. Source and available listings
have independent filters and sortable columns.

`writeJars` requires an explicit acquisition source and includes a small versioned
record with the jar in the same Docker archive write. Records live in the server
volume's `.mcsm-mod-sources/` directory, keyed by directory and filename, and
include SHA-1. Per-file records avoid shared-manifest update races. Deletion also
removes the corresponding record. Source metadata follows existing backup,
restore and server-copy operations without an application database migration.

Manual jar and ZIP uploads record Manual upload, including uploads that replace
a recognized provider download. New provider downloads and dependencies record
the selected provider; the legacy Modrinth install/update routes do the same.
Unchanged dependencies retain their recorded source. Inventory only displays a
recorded source when the current file's hash matches. Existing untracked files
and changed external files stay Unknown, regardless of detected listings.

### Dependency tags and direct dependents

New installations persist provider-qualified project references, direct required
dependency links and automatic dependency status in the existing hash-bound
source records. Both provider routes and the legacy Modrinth install route share
the same planner. Already installed dependencies keep their source and are linked
from the new parent's record; shared and nested dependencies retain every direct
edge. Exact-content hash fallbacks support identical artifacts across providers.

Inventory derives reverse links from current files. The **Dependency** badge
shows direct requiring mods on hover or keyboard focus, and a **Dependencies**
status filter narrows the table. Deleted parents disappear from dependent lists;
unused automatically installed dependencies retain their badge with an explicit
empty state. No dependency is removed automatically. Metadata follows backups and
server copies, and changed hashes invalidate stale relationships.

Modrinth updates preserve automatic dependency history, record the new project
identity and refresh required links, including version-only references. Project
references keep relationships intact when a dependency's filename or version
changes. Old installations without recorded relationships are not retroactively
classified; subsequent installations or updates establish links.

### Incremental inventory and update checks

The original refresh path transferred the mods directory for listing and again
for fingerprints, forced both provider lookups after each install, then hashed
the collection independently for update detection. Typed-array filtering in the
CurseForge fingerprint also allocated a filtered copy of every jar.

Listings now read metadata through one read-only volume helper, shared by
concurrent requests and cached for one second. Writes/deletions invalidate this
listing even on partial failures. Signature entries are keyed by filename, size,
nanosecond mtime/ctime and inode; only new or changed jars are transferred, with
four reads at a time and a 100 MB limit per file. Signatures are periodically
reverified after five minutes. Provider matches (including unrecognized files)
are cached by SHA-1 and fingerprint for five minutes, with separate provider,
directory and API-key configuration scopes. Concurrent lookups share promises;
failures are retried rather than cached as missing mods.

Modrinth update checks use inventory identities and signatures, with per-artifact
results cached for ten minutes and scoped to loader and Minecraft version.
Adding one file only queries its uncached matches and update state. Routine UI
refreshes no longer bypass caches; the explicit **Refresh** button still forces
a full verification. Pre-install duplicate checks force a new metadata listing
while reusing hash-bound provider identities for unchanged files.

A local CPU benchmark of 40 synthetic 4 MiB files dropped from 8.27 seconds to
1.12 seconds for fingerprints alone (the same unsigned result). This is not an
end-to-end server timing. Regression tests verify that adding a 41st jar reads
and identifies only that jar and that updates share those signatures.


### Portable mod lists

The **Mod list** menu exports a versioned JSON manifest and imports it into the
currently open world. Optional fields include names, installed versions,
filenames, sources, source pages, file sizes, modification dates and source-world
information. IDs and dependency flags remain required for portable references;
unrecognized entries keep a manual-upload filename. Export can be limited to
selected mods and can exclude dependencies. Manifests are validated before any
request, with a 2 MB / 1,000-entry limit; arbitrary download URLs are ignored.

Import runs selected roots before explicit dependency entries through the common
installation route, one root graph at a time. Each graph is resolved and verified
before writes, preserving the existing per-install limits. This bounds memory
for large collections and allows progress, individual failures, retries and stop
after the current mod. Restart is disabled per entry and occurs at most once at
the end. Navigating to another world stops the queue after the in-flight entry.

Import can select latest compatible builds or exported version IDs. Existing
roots and libraries are resolved at their current version, retained, and checked
recursively for missing dependencies. Hash-bound forward metadata is refreshed
without rewriting those jars or changing their sources. An unknown origin stays
Unknown when adding dependency metadata. Different requested installed versions
are conflicts and never trigger automatic replacement. Ordinary browser installs
still reject duplicate roots. Publicly recognized uploads can be downloaded;
private files require separate manual upload. Successful earlier entries remain
installed if a later entry fails.
