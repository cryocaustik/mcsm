<template>
  <USlideover
    v-model:open="open"
    :title="mode === 'export' ? 'Export mod list' : 'Import mod list'"
    :description="
      mode === 'export'
        ? 'Save a reusable list for another world.'
        : `Install a saved list into ${server?.name ?? 'this world'}.`
    "
    :dismissible="!importing"
    :close="!importing"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <div v-if="mode === 'export'" class="space-y-5">
        <UCheckbox
          v-if="selected.length"
          v-model="onlySelected"
          :label="`Export selected mods only (${selected.length})`"
        />
        <USwitch v-model="includeDependencies" label="Include dependencies" />
        <p class="text-sm text-muted">
          Required dependencies are checked during import, even when excluded
          from this list.
        </p>
        <div class="space-y-3">
          <h3 class="font-semibold">Optional fields</h3>
          <UCheckboxGroup
            v-model="fields"
            :items="fieldOptions"
            class="grid sm:grid-cols-2 gap-3"
          />
          <p class="text-xs text-muted">
            Project references and dependency tags are always included. Files
            without a download reference keep their filename for manual upload.
          </p>
        </div>
        <UAlert
          color="info"
          variant="soft"
          :description="`${exportList.mods.length} mods in this list. The export contains references, without jar files or configuration.`"
        />
        <UAlert
          v-if="manualExports"
          color="warning"
          variant="soft"
          :description="`${manualExports} files have no usable provider reference. Upload those jars separately in the destination world.`"
        />
        <UAlert
          v-if="exportError"
          color="error"
          variant="soft"
          :description="exportError"
        />
        <details class="rounded-lg border border-default bg-elevated/30 p-4">
          <summary class="cursor-pointer text-sm font-medium">
            Preview export
          </summary>
          <pre class="mt-3 max-h-80 overflow-auto text-xs select-text">{{
            exportJson
          }}</pre>
        </details>
      </div>
      <div v-else class="space-y-5">
        <div class="flex flex-wrap items-center gap-3">
          <input
            ref="fileInput"
            type="file"
            accept=".json,application/json"
            class="hidden"
            @change="readList"
          />
          <UButton
            icon="i-heroicons-document-arrow-up-20-solid"
            variant="outline"
            :disabled="importing || reading"
            :loading="reading"
            @click="fileInput?.click()"
            >Choose mod list</UButton
          >
          <span v-if="fileName" class="text-sm text-muted break-all">{{
            fileName
          }}</span>
        </div>
        <UAlert
          v-if="fileError"
          color="error"
          variant="soft"
          :description="fileError"
        />
        <template v-if="importList">
          <UAlert
            color="info"
            variant="soft"
            title="Compatibility and dependencies"
            description="Each mod is checked against this world's loader and Minecraft version. Existing mods are kept and their required dependencies are checked again. Other installed mods stay in place."
          />
          <p v-if="importList.environment" class="text-xs text-muted">
            Exported from {{ importList.environment.name ?? "another world"
            }}<template v-if="importList.environment.minecraftVersion">
              · Minecraft
              {{ importList.environment.minecraftVersion }}</template
            ><template v-if="importList.environment.loader">
              · {{ importList.environment.loader }}</template
            >
          </p>
          <div class="space-y-3">
            <UCheckbox
              v-model="useListedVersions"
              label="Use listed versions when available"
              description="Leave off to select the latest compatible builds. Listed versions must match the destination world and any already installed version."
              :disabled="importing"
            />
            <UCheckbox
              v-model="restartAfter"
              label="Restart once after import"
              :disabled="importing"
            />
            <USelect
              v-if="server?.config?.type === 'AUTO_CURSEFORGE'"
              v-model="loader"
              :items="loaderOptions"
              aria-label="Destination mod loader"
              :disabled="importing"
              class="w-48"
            />
          </div>
          <UAlert
            v-if="manualImports"
            color="warning"
            variant="soft"
            :description="`${manualImports} files need a manual upload. Their names are included below.`"
          />
          <UAlert
            v-if="unavailableImports"
            color="warning"
            variant="soft"
            description="Some entries use CurseForge. Ask an administrator to configure its API key in Admin → Secrets, then reopen this list to import those entries."
          />
          <div
            v-if="importing || finished"
            class="space-y-2"
            aria-live="polite"
          >
            <UProgress :model-value="completed" :max="Math.max(total, 1)" />
            <p class="text-sm text-muted">
              {{
                importing
                  ? "Importing"
                  : stopped
                    ? "Import stopped"
                    : "Import finished"
              }}
              · {{ completed }} of {{ total }} checked · {{ addedFiles }} files
              added
            </p>
          </div>
          <UAlert
            v-if="restartError"
            color="warning"
            variant="soft"
            title="Restart needed"
            :description="restartError"
          />
          <p v-if="!importing" class="text-xs text-muted">
            {{ chosen.size }} of {{ rows.length }} entries selected
          </p>
          <div class="overflow-x-auto rounded-lg border border-default">
            <table class="w-full text-sm text-left">
              <thead class="bg-elevated/50 text-muted text-xs">
                <tr>
                  <th class="p-3 w-10">
                    <UCheckbox
                      :model-value="allChosen"
                      :disabled="importing || !eligible.length"
                      aria-label="Select all importable mods"
                      @update:model-value="toggleAll"
                    />
                  </th>
                  <th class="p-3">Mod</th>
                  <th class="p-3">Source</th>
                  <th class="p-3">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="(row, index) in rows" :key="index">
                  <td class="p-3 align-top">
                    <UCheckbox
                      :model-value="chosen.has(index)"
                      :disabled="
                        importing ||
                        row.entry.provider === 'manual' ||
                        row.status === 'unavailable'
                      "
                      :aria-label="`Import ${modListEntryName(row.entry)}`"
                      @update:model-value="toggle(index)"
                    />
                  </td>
                  <td class="p-3 align-top min-w-48 max-w-xs break-words">
                    <p class="font-medium">{{ modListEntryName(row.entry) }}</p>
                    <p v-if="row.entry.version" class="text-xs text-muted mt-1">
                      {{ row.entry.version }}
                    </p>
                    <UBadge
                      v-if="row.entry.dependency"
                      size="xs"
                      color="info"
                      variant="soft"
                      class="mt-1"
                      >Dependency</UBadge
                    >
                  </td>
                  <td class="p-3 align-top whitespace-nowrap text-xs">
                    {{
                      row.entry.provider === "manual"
                        ? "Manual upload"
                        : modSourceLabel(row.entry.provider)
                    }}
                  </td>
                  <td class="p-3 align-top min-w-44 max-w-sm">
                    <p
                      :class="
                        row.status === 'failed' ? 'text-error' : 'text-muted'
                      "
                    >
                      {{ statusLabel(row) }}
                    </p>
                    <p v-if="row.message" class="text-xs mt-1">
                      {{ row.message }}
                    </p>
                    <p v-if="row.hint" class="text-xs text-muted mt-1">
                      {{ row.hint }}
                    </p>
                    <p
                      v-if="row.reference"
                      class="text-xs font-mono text-muted mt-1 break-all"
                    >
                      Reference: {{ row.reference }}
                    </p>
                  </td>
                </tr>
                <tr v-if="!rows.length">
                  <td colspan="4" class="p-6 text-center text-muted">
                    This list has no mods.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p v-else-if="!fileError" class="text-sm text-muted">
          Choose the JSON file exported from another world's Files tab.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-2 w-full">
        <UButton
          v-if="!importing"
          color="neutral"
          variant="ghost"
          @click="open = false"
          >Close</UButton
        >
        <UButton
          v-if="mode === 'export'"
          icon="i-heroicons-arrow-down-tray-20-solid"
          :disabled="!exportList.mods.length || Boolean(exportError)"
          @click="downloadList"
          >Export JSON</UButton
        >
        <template v-else>
          <UButton
            v-if="importing"
            color="warning"
            variant="outline"
            :disabled="stopRequested"
            @click="stopRequested = true"
            >{{
              stopRequested
                ? "Stopping after current mod…"
                : "Stop after current mod"
            }}</UButton
          >
          <UButton
            v-else-if="rows.some((row) => row.status === 'failed')"
            color="neutral"
            variant="outline"
            @click="retryFailed"
            >Retry failed</UButton
          >
          <UButton
            v-if="!importing"
            :disabled="!chosen.size || reading"
            icon="i-heroicons-arrow-down-tray-20-solid"
            @click="startImport"
            >Import {{ chosen.size }} mods</UButton
          >
        </template>
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import type { InstalledMod, ModInventory } from "#shared/types/mods";
import type {
  ModList,
  ModListField,
  ModInstallResult,
} from "#shared/types/mod-list";
import {
  createModList,
  parseModList,
  modListEntryName,
  MAX_MOD_LIST_BYTES,
} from "#shared/utils/mod-list";
import {
  installedModKeys,
  modProjectKey,
  modSourceLabel,
} from "#shared/utils/mods";
import { errorMessage } from "~/utils/errors";
import { runModImport, type ModImportRow } from "~/utils/mod-import";

const open = defineModel<boolean>("open", { default: false });
const restartAfter = defineModel<boolean>("restart", { default: true });
const props = defineProps<{
  mode: "export" | "import";
  mods: InstalledMod[];
  selected: string[];
  providers: ModInventory["providers"];
}>();
const emit = defineEmits<{ installed: [] }>();
const { id, server, refresh: refreshServer } = useServerDetail();
const onlySelected = ref(false);
watch(
  () => props.selected.length,
  (length) => {
    if (!length) onlySelected.value = false;
  }
);
const includeDependencies = ref(true);
const fields = ref<ModListField[]>([
  "name",
  "filename",
  "version",
  "source",
  "websiteUrl",
  "environment",
]);
const fieldOptions = [
  { label: "Mod name", value: "name" },
  { label: "Installed version", value: "version" },
  { label: "Filename", value: "filename" },
  { label: "Mod source", value: "source" },
  { label: "Source page link", value: "websiteUrl" },
  { label: "File size", value: "size" },
  { label: "Last modified", value: "modifiedAt" },
  { label: "World and Minecraft information", value: "environment" },
];
const exportList = computed(() =>
  createModList(
    onlySelected.value
      ? props.mods.filter((mod) => props.selected.includes(mod.filename))
      : props.mods,
    {
      fields: fields.value,
      includeDependencies: includeDependencies.value,
      environment: {
        name: server.value?.name,
        minecraftVersion: server.value?.config?.VERSION?.label,
        loader: server.value?.config?.type ?? undefined,
      },
    }
  )
);
const exportJson = computed(() => JSON.stringify(exportList.value, null, 2));
const exportError = computed(() => {
  try {
    parseModList(exportJson.value);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
});
const manualExports = computed(
  () =>
    exportList.value.mods.filter((entry) => entry.provider === "manual").length
);
function downloadList() {
  if (exportError.value) return;
  const url = URL.createObjectURL(
    new Blob([exportJson.value], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(server.value?.name ?? "world").replace(/[^a-zA-Z0-9_-]+/g, "-")}-mods.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");
const fileName = ref("");
const fileError = ref("");
const reading = ref(false);
const importList = shallowRef<ModList | null>(null);
const rows = ref<ModImportRow[]>([]);
const chosen = ref(new Set<number>());
const useListedVersions = ref(false);
const loader = ref("auto");
const loaderOptions = [
  { label: "Detect mod loader", value: "auto" },
  { label: "Forge", value: "forge" },
  { label: "NeoForge", value: "neoforge" },
  { label: "Fabric", value: "fabric" },
];
const importing = ref(false);
const stopRequested = ref(false);
const stopped = ref(false);
const finished = ref(false);
const completed = ref(0);
const total = ref(0);
const addedFiles = ref(0);
const restartError = ref("");
let disposed = false;
let fileGeneration = 0;
const installedKeys = computed(() => installedModKeys(props.mods));
const manualImports = computed(
  () => rows.value.filter((row) => row.status === "manual").length
);
const unavailableImports = computed(
  () => rows.value.filter((row) => row.status === "unavailable").length
);
const eligible = computed(() =>
  rows.value.flatMap((row, index) =>
    row.entry.provider !== "manual" && row.status !== "unavailable"
      ? [index]
      : []
  )
);
const allChosen = computed(
  () =>
    eligible.value.length > 0 &&
    eligible.value.every((index) => chosen.value.has(index))
);
watch(
  () => props.providers,
  () => {
    if (importing.value) return;
    const next = new Set(chosen.value);
    rows.value.forEach((row, index) => {
      if (
        row.entry.provider === "manual" ||
        !["ready", "unavailable"].includes(row.status)
      )
        return;
      const available =
        props.providers.find((provider) => provider.id === row.entry.provider)
          ?.available !== false;
      if (!available) {
        row.status = "unavailable";
        next.delete(index);
      } else if (row.status === "unavailable") {
        row.status = "ready";
        next.add(index);
      }
    });
    chosen.value = next;
  }
);
function toggle(index: number) {
  const next = new Set(chosen.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  chosen.value = next;
}
function toggleAll() {
  chosen.value = allChosen.value ? new Set() : new Set(eligible.value);
}
async function readList(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || importing.value) return;
  const generation = ++fileGeneration;
  fileName.value = file.name;
  fileError.value = "";
  importList.value = null;
  rows.value = [];
  chosen.value = new Set();
  finished.value = false;
  restartError.value = "";
  reading.value = true;
  try {
    if (file.size > MAX_MOD_LIST_BYTES)
      throw new Error("Mod lists must be smaller than 2 MB.");
    const list = parseModList(await file.text());
    if (generation !== fileGeneration || disposed) return;
    importList.value = list;
    rows.value = list.mods.map((entry) => ({
      entry,
      status:
        entry.provider === "manual"
          ? "manual"
          : props.providers.find((provider) => provider.id === entry.provider)
                ?.available === false
            ? "unavailable"
            : "ready",
    }));
    chosen.value = new Set(eligible.value);
  } catch (error) {
    if (generation === fileGeneration)
      fileError.value = (error as Error).message;
  } finally {
    if (generation === fileGeneration) reading.value = false;
  }
}
function statusLabel(row: ModImportRow) {
  if (
    row.status === "ready" &&
    row.entry.provider !== "manual" &&
    installedKeys.value.has(
      modProjectKey(row.entry.provider, row.entry.projectId)
    )
  )
    return "Installed; check dependencies";
  return {
    ready: "Ready",
    installing: "Checking and installing…",
    installed: `Installed (${row.added ?? 0} files)`,
    repaired: `Dependencies added (${row.added ?? 0})`,
    skipped: "Installed; dependencies checked",
    failed: "Failed",
    manual: "Manual upload required",
    unavailable: "Provider unavailable",
  }[row.status];
}
async function startImport() {
  if (importing.value || !chosen.value.size) return;
  const targetId = id.value;
  const workIndices = new Set(chosen.value);
  const work = rows.value.filter((_, index) => workIndices.has(index));
  const pinVersions = useListedVersions.value;
  const targetLoader = loader.value;
  const shouldRestart = restartAfter.value;
  importing.value = true;
  finished.value = false;
  stopped.value = false;
  stopRequested.value = false;
  restartError.value = "";
  addedFiles.value = completed.value = 0;
  total.value = work.length;
  try {
    const result = await runModImport(work, {
      shouldStop: () =>
        stopRequested.value || disposed || id.value !== targetId,
      install: (entry) =>
        $fetch<ModInstallResult>(`/api/server/${targetId}/mods/install`, {
          method: "POST",
          body: {
            provider: entry.provider,
            project: entry.projectId,
            restart: false,
            skipInstalled: true,
            dependency: entry.dependency,
            ...(pinVersions && entry.versionId
              ? { versionId: entry.versionId }
              : {}),
            ...(targetLoader !== "auto" ? { loader: targetLoader } : {}),
          },
        }),
      onResult: (row) => {
        completed.value++;
        addedFiles.value += row.added ?? 0;
      },
    });
    stopped.value = stopRequested.value || completed.value < total.value;
    if (disposed || id.value !== targetId) return;
    if (result.added && shouldRestart && server.value?.running) {
      try {
        await $fetch(`/api/server/${targetId}/restart`, { method: "POST" });
        await refreshServer();
      } catch (error) {
        restartError.value = errorMessage(
          error,
          "Mods were imported, but the server could not restart. Restart it from the Console to apply them."
        );
      }
    }
    finished.value = true;
    chosen.value = new Set(
      [...workIndices].filter(
        (index) =>
          rows.value[index]?.status === "failed" ||
          rows.value[index]?.status === "ready"
      )
    );
  } finally {
    importing.value = false;
    if (!disposed && id.value === targetId) emit("installed");
  }
}
function retryFailed() {
  chosen.value = new Set(
    rows.value.flatMap((row, index) => (row.status === "failed" ? [index] : []))
  );
  startImport();
}
watch(id, () => {
  stopRequested.value = true;
  fileGeneration++;
  open.value = false;
  importList.value = null;
  rows.value = [];
  chosen.value = new Set();
  fileName.value = fileError.value = "";
  finished.value = false;
});
onBeforeUnmount(() => {
  disposed = true;
  stopRequested.value = true;
  fileGeneration++;
});
</script>
