<template>
  <div class="space-y-6">
    <!-- Unsupported server type -->
    <UCard v-if="!supported">
      <div class="text-sm text-muted py-10 text-center space-y-2">
        <UIcon
          name="i-heroicons-puzzle-piece"
          class="size-8 mx-auto opacity-60"
        />
        <p class="font-medium text-highlighted">
          {{
            server?.config?.type === "FTBA"
              ? "FTB modpacks manage their own mods"
              : "This server type can't load mods or plugins"
          }}
        </p>
        <p class="max-w-md mx-auto">
          {{
            server?.config?.type === "FTBA"
              ? "The Feed The Beast installer owns the mods folder and re-syncs it on every start — manually added files would be removed again."
              : "Vanilla servers have no plugin or mod loader. Use a Paper, Fabric, Forge, NeoForge or CurseForge modpack server to install plugins or mods."
          }}
        </p>
      </div>
    </UCard>

    <template v-else>
      <!-- Jar manager -->
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="font-semibold">{{ kindLabel }}</h3>
              <p class="text-sm text-muted">
                Manage installed files or download compatible builds from
                Modrinth and CurseForge.
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <UButton
                v-if="selectedJars.length"
                icon="i-heroicons-trash-20-solid"
                color="error"
                variant="soft"
                size="sm"
                @click="batchDeleteOpen = true"
              >
                Delete {{ selectedJars.length }}
              </UButton>
              <UButton
                v-if="updatableJars.length"
                icon="i-heroicons-arrow-path-20-solid"
                color="warning"
                variant="soft"
                size="sm"
                :loading="updating"
                @click="runUpdate(updatableJars.map((u) => u.filename))"
              >
                Update all ({{ updatableJars.length }})
              </UButton>
              <UButton
                icon="i-heroicons-arrow-path-20-solid"
                variant="ghost"
                color="neutral"
                size="sm"
                :loading="inventoryStatus === 'pending'"
                @click="forceRefreshModData"
                >Refresh</UButton
              >
              <UButton
                icon="i-heroicons-arrow-up-tray-20-solid"
                variant="outline"
                color="neutral"
                size="sm"
                @click="showUpload = !showUpload"
                >Upload files</UButton
              >
              <UDropdownMenu :items="modListActions">
                <UButton
                  icon="i-heroicons-document-text-20-solid"
                  variant="outline"
                  color="neutral"
                  size="sm"
                  :disabled="
                    inventoryStatus === 'pending' || Boolean(inventoryError)
                  "
                  >Mod list</UButton
                >
              </UDropdownMenu>
              <UButton
                icon="i-heroicons-globe-alt-20-solid"
                variant="soft"
                size="sm"
                @click="browserOpen = true"
              >
                Download {{ kindLabel.toLowerCase() }}
              </UButton>
              <div class="flex items-center gap-2">
                <USwitch v-model="restartAfter" size="sm" />
                <span class="text-xs text-muted whitespace-nowrap">
                  Restart after changes
                </span>
              </div>
            </div>
          </div>
        </template>

        <div class="space-y-5">
          <!-- Upload drop zone -->
          <UFileUpload
            v-if="showUpload"
            v-model="uploadFiles"
            accept=".jar,.zip"
            multiple
            variant="area"
            layout="list"
            position="outside"
            :file-image="false"
            file-icon="i-heroicons-puzzle-piece-20-solid"
            icon="i-heroicons-arrow-up-tray-20-solid"
            :label="`Drop ${kindLabel.toLowerCase()} here`"
            description=".jar files or .zip bundles, max 100 MB"
            :disabled="uploading"
            class="min-h-32"
          >
            <template #files-bottom="{ files }">
              <UButton
                v-if="files?.length"
                icon="i-heroicons-arrow-up-tray-20-solid"
                :loading="uploading"
                class="self-start"
                @click="upload"
              >
                Upload {{ files.length }}
                {{ files.length === 1 ? "file" : "files" }}
              </UButton>
            </template>
          </UFileUpload>

          <UAlert
            v-if="jarsError"
            color="error"
            variant="soft"
            title="Could not load installed files"
            :description="errorMessage(jarsError, 'Try refreshing the list.')"
          />
          <UAlert
            v-if="inventoryError"
            color="warning"
            variant="soft"
            description="Could not identify installed mods. Local files remain available; refresh to retry."
          />
          <UAlert
            v-for="warning in inventory?.warnings ?? []"
            :key="warning"
            color="warning"
            variant="soft"
            :description="warning"
          />
          <p
            v-if="inventoryStatus === 'pending'"
            class="text-xs text-muted"
            role="status"
          >
            Identifying installed files on Modrinth and CurseForge…
          </p>
          <p
            v-if="jarsStatus === 'pending' && !jars.length"
            class="py-8 text-center text-muted"
            role="status"
          >
            Loading installed files…
          </p>
          <ServerDetailInstalledModsTable
            v-else
            v-model:selected="selectedJars"
            :mods="installedMods"
            :updates="updatesByFilename"
            :menu-items="modMenuItems"
          />

          <!-- Integration jars hint -->
          <UAlert
            icon="i-heroicons-information-circle"
            color="info"
            variant="soft"
            :description="integrationHint"
          />
        </div>
      </UCard>

      <ServerDetailFileManager v-model:restart-after="restartAfter" />
    </template>

    <!-- Single jar delete confirmation -->
    <UModal
      v-model:open="deleteOpen"
      title="Delete jar"
      :description="`Delete ${pendingDelete}? ${restartAfter && server?.running ? 'The server restarts afterwards.' : 'The change applies on the next restart.'}`"
    >
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="deleting"
            @click="deleteOpen = false"
          >
            Cancel
          </UButton>
          <UButton color="error" :loading="deleting" @click="runDelete">
            Delete
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Batch delete confirmation -->
    <UModal
      v-model:open="batchDeleteOpen"
      title="Delete selected jars"
      :description="`Delete ${selectedJars.length} ${selectedJars.length === 1 ? 'jar' : 'jars'}? ${restartAfter && server?.running ? 'The server restarts once afterwards.' : 'The change applies on the next restart.'}`"
    >
      <template #body>
        <ul class="text-sm font-mono text-muted space-y-1">
          <li v-for="name in selectedJars" :key="name">{{ name }}</li>
        </ul>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="deleting"
            @click="batchDeleteOpen = false"
          >
            Cancel
          </UButton>
          <UButton color="error" :loading="deleting" @click="runBatchDelete">
            Delete {{ selectedJars.length }}
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Download browser -->
    <ServerDetailModListTransfer
      v-model:open="modListOpen"
      v-model:restart="restartAfter"
      :mode="modListMode"
      :mods="installedMods"
      :selected="selectedJars"
      :providers="inventory?.providers ?? []"
      @installed="refreshModData"
    />
    <ServerDetailModBrowser
      v-model:open="browserOpen"
      :installed-project-keys="installedProjectKeys"
      :providers="inventory?.providers ?? []"
      :inventory-pending="inventoryStatus === 'pending'"
      :restart="restartAfter"
      :kind-label="kindLabel"
      @installed="refreshModData"
    />
  </div>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { InstalledMod, ModInventory } from "#shared/types/mods";
import { installedModKeys } from "#shared/utils/mods";
import { errorMessage } from "~/utils/errors";

type JarInfo = { name: string; size: number; modifiedAt?: string | null };

const { id, server, refresh: refreshServer } = useServerDetail();
const toast = useToast();

// --- Type gating ----------------------------------------------------------------

const SUPPORTED = ["PAPER", "FABRIC", "FORGE", "NEOFORGE", "AUTO_CURSEFORGE"];
const supported = computed(() =>
  SUPPORTED.includes(server.value?.config?.type ?? "")
);
const kindLabel = computed(() =>
  server.value?.config?.type === "PAPER" ? "Plugins" : "Mods"
);

const integrationHint = computed(() => {
  const base =
    "Jars installed by integrations (BlueMap, Chunky) are managed through MODRINTH_PROJECTS and re-download on the next start if deleted here.";
  return server.value?.config?.type === "AUTO_CURSEFORGE"
    ? `${base} Mods that belong to the CurseForge modpack also re-sync on the next start.`
    : base;
});

// --- Data -----------------------------------------------------------------------

const forceModRefresh = ref(false);

const {
  data: jars,
  refresh: refreshJars,
  status: jarsStatus,
  error: jarsError,
} = useFetch<JarInfo[]>(() => `/api/server/${id.value}/jars`, {
  default: () => [],
  retry: false,
  immediate: true,
  watch: false,
});

const {
  data: inventory,
  refresh: refreshInventory,
  status: inventoryStatus,
  error: inventoryError,
} = useFetch<ModInventory>(() => `/api/server/${id.value}/mods`, {
  key: computed(() => `server-mod-inventory:${id.value}`),
  query: { refresh: computed(() => String(forceModRefresh.value)) },
  watch: false,
  lazy: true,
  retry: false,
  default: () => ({ mods: [], warnings: [], providers: [] }),
});
const installedMods = computed<InstalledMod[]>(() => {
  const identified = new Map(
    (inventory.value?.mods ?? []).map((mod) => [mod.filename, mod])
  );
  return (jars.value ?? []).map((jar) => {
    const mod = identified.get(jar.name);
    return {
      filename: jar.name,
      size: jar.size,
      modifiedAt: jar.modifiedAt ?? null,
      source: mod?.source ?? "unknown",
      dependency: mod?.dependency ?? false,
      requiredBy: mod?.requiredBy ?? [],
      identities: mod?.identities ?? [],
      managed: Boolean(mod?.managed || projectInfoFor(jar.name)?.managed),
    };
  });
});
const installedProjectKeys = computed(() =>
  installedModKeys(installedMods.value)
);
const selectedJars = ref<string[]>([]);
const modListOpen = ref(false);
const modListMode = ref<"export" | "import">("export");
const modListActions: DropdownMenuItem[] = [
  {
    label: "Export mod list",
    icon: "i-heroicons-document-arrow-down-20-solid",
    onSelect: () => {
      modListMode.value = "export";
      modListOpen.value = true;
    },
  },
  {
    label: "Import mod list",
    icon: "i-heroicons-document-arrow-up-20-solid",
    onSelect: () => {
      modListMode.value = "import";
      modListOpen.value = true;
    },
  },
];
const showUpload = ref(false);

// --- Upload ----------------------------------------------------------------------

const uploadFiles = ref<File[]>([]);
const uploading = ref(false);
const restartAfter = ref(true);

async function upload() {
  if (!uploadFiles.value.length) return;
  uploading.value = true;
  try {
    const body = new FormData();
    for (const file of uploadFiles.value) body.append("files", file);

    const result = await $fetch<{ added: string[]; restarted: boolean }>(
      `/api/server/${id.value}/jars`,
      {
        method: "POST",
        query: { restart: String(restartAfter.value) },
        body,
      }
    );

    toast.add({
      title: `${result.added.length} ${result.added.length === 1 ? "jar" : "jars"} uploaded`,
      description: result.restarted
        ? "The server is restarting to load them."
        : "They load on the next server start.",
      color: "success",
    });
    uploadFiles.value = [];
    await refreshModData();
    if (result.restarted) await refreshServer();
  } catch (error) {
    toast.add({
      title: "Upload failed",
      description: errorMessage(error, "Could not upload the files."),
      color: "error",
    });
  } finally {
    uploading.value = false;
  }
}

// --- Modrinth updates -------------------------------------------------------------

type JarUpdate = {
  filename: string;
  projectId: string;
  latestVersion: string;
  latestFilename: string;
  managed: boolean;
};

const browserOpen = ref(false);
const updating = ref(false);

// Share cached hashes with inventory; file changes invalidate only affected jars.
const { data: modrinthInfo, refresh: refreshUpdates } = useFetch<{
  projects: Record<string, { projectId: string; managed: boolean }>;
  updates: JarUpdate[];
}>(() => `/api/server/${id.value}/modrinth/updates`, {
  key: computed(() => `server-mod-updates:${id.value}`),
  retry: false,
  immediate: true,
  query: { refresh: computed(() => String(forceModRefresh.value)) },
  watch: false,
  // Update info is a nice-to-have; never block the tab on Modrinth being slow.
  lazy: true,
  default: () => ({ projects: {}, updates: [] }),
});

function updateFor(filename: string): JarUpdate | undefined {
  return modrinthInfo.value?.updates.find(
    (update) => update.filename === filename
  );
}

function projectInfoFor(filename: string) {
  return modrinthInfo.value?.projects[filename];
}

/** Jars with updates the user can actually apply (auto-installed ones re-sync on boot). */
const updatableJars = computed(() =>
  (modrinthInfo.value?.updates ?? []).filter((update) => !update.managed)
);

const updatesByFilename = computed(() =>
  Object.fromEntries(
    (modrinthInfo.value?.updates ?? []).map((update) => [
      update.filename,
      update,
    ])
  )
);

async function runUpdate(filenames: string[]) {
  if (!filenames.length) return;
  updating.value = true;
  try {
    const result = await $fetch<{
      updated: { from: string; to: string; version: string }[];
      failed: { filename: string; reason: string }[];
      restarted: boolean;
    }>(`/api/server/${id.value}/modrinth/update`, {
      method: "POST",
      body: { filenames, restart: restartAfter.value },
    });

    if (result.updated.length) {
      toast.add({
        title: `${result.updated.length} ${result.updated.length === 1 ? "jar" : "jars"} updated`,
        description: result.restarted
          ? "The server is restarting to load them."
          : "Updates load on the next server start.",
        color: "success",
      });
    }
    for (const failure of result.failed) {
      toast.add({
        title: `${failure.filename} not updated`,
        description: failure.reason,
        color: "warning",
      });
    }

    await refreshModData();
    if (result.restarted) await refreshServer();
  } catch (error) {
    toast.add({
      title: "Update failed",
      description: errorMessage(error, "Could not update the jars."),
      color: "error",
    });
  } finally {
    updating.value = false;
  }
}

async function forceRefreshModData() {
  forceModRefresh.value = true;
  try {
    await refreshModData();
  } finally {
    forceModRefresh.value = false;
  }
}

async function refreshModData() {
  await Promise.all([
    refreshJars(),
    refreshInventory({ dedupe: "cancel" }),
    refreshUpdates({ dedupe: "cancel" }),
  ]);
}

// --- Delete ----------------------------------------------------------------------

const deleteOpen = ref(false);
const batchDeleteOpen = ref(false);
const deleting = ref(false);
const pendingDelete = ref("");

function modMenuItems(mod: InstalledMod) {
  return jarMenuItems({ name: mod.filename, size: mod.size });
}

function jarMenuItems(jar: JarInfo): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [];

  const update = updateFor(jar.name);
  if (
    update &&
    !update.managed &&
    !installedMods.value.find((mod) => mod.filename === jar.name)?.managed
  ) {
    items.push({
      label: `Update to ${update.latestVersion}`,
      icon: "i-heroicons-arrow-path-20-solid",
      onSelect: () => runUpdate([jar.name]),
    });
  }

  items.push(
    {
      label: "Download",
      icon: "i-heroicons-arrow-down-tray-20-solid",
      onSelect: () => {
        window.open(
          `/api/server/${id.value}/jars/${encodeURIComponent(jar.name)}`,
          "_blank"
        );
      },
    },
    {
      label: "Delete",
      icon: "i-heroicons-trash-20-solid",
      color: "error",
      onSelect: () => {
        pendingDelete.value = jar.name;
        deleteOpen.value = true;
      },
    }
  );

  return items;
}

async function deleteOne(name: string, restart: boolean) {
  await $fetch(`/api/server/${id.value}/jars/${encodeURIComponent(name)}`, {
    method: "DELETE",
    query: { restart: String(restart) },
  });
}

async function runDelete() {
  if (!pendingDelete.value) return;
  deleting.value = true;
  try {
    await deleteOne(pendingDelete.value, restartAfter.value);
    toast.add({ title: `${pendingDelete.value} deleted`, color: "success" });
    deleteOpen.value = false;
    selectedJars.value = selectedJars.value.filter(
      (name) => name !== pendingDelete.value
    );
    await refreshModData();
  } catch (error) {
    toast.add({
      title: "Delete failed",
      description: errorMessage(error, "Could not delete the jar."),
      color: "error",
    });
  } finally {
    deleting.value = false;
  }
}

async function runBatchDelete() {
  if (!selectedJars.value.length) return;
  deleting.value = true;
  try {
    // Delete without restarting, then restart once at the end if requested.
    for (const name of selectedJars.value) {
      await deleteOne(name, false);
    }
    if (restartAfter.value && server.value?.running) {
      await $fetch(`/api/server/${id.value}/restart`, { method: "POST" });
    }
    toast.add({
      title: `${selectedJars.value.length} jars deleted`,
      color: "success",
    });
    batchDeleteOpen.value = false;
    selectedJars.value = [];
    await refreshModData();
  } catch (error) {
    toast.add({
      title: "Delete failed",
      description: errorMessage(error, "Could not delete all jars."),
      color: "error",
    });
    await refreshModData();
  } finally {
    deleting.value = false;
  }
}

// --- Container identity changes (config edits recreate the container) ---------------

watch(id, () => {
  selectedJars.value = [];
  uploadFiles.value = [];
  browserOpen.value = false;
  refreshModData();
});
</script>
