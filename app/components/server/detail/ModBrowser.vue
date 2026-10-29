<template>
  <USlideover
    v-model:open="open"
    :title="`Download ${kindLabel.toLowerCase()}`"
    description="Choose a source and find compatible builds for this server."
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <div class="flex flex-wrap gap-2">
          <USelect
            v-model="provider"
            :items="providerOptions"
            aria-label="Download source"
            class="w-40"
          />
          <UInput
            v-model="query"
            icon="i-heroicons-magnifying-glass-20-solid"
            :placeholder="`Search ${providerLabel}…`"
            aria-label="Search for downloads"
            class="flex-1 min-w-48"
            autofocus
            :maxlength="200"
          />
          <USelect
            v-model="sort"
            :items="sortOptions"
            aria-label="Sort search results"
            class="w-40"
          />
          <USelect
            v-if="isModpackServer"
            v-model="loaderOverride"
            :items="loaderOptions"
            aria-label="Mod loader"
            class="w-36"
          />
        </div>

        <UAlert
          v-if="!providerAvailable"
          color="warning"
          variant="soft"
          icon="i-heroicons-key"
          :description="providerReason"
        />
        <p v-if="searchMeta" class="text-xs text-muted" aria-live="polite">
          {{ searchMeta.loader }} · Minecraft {{ searchMeta.gameVersion }} ·
          {{ searchMeta.total.toLocaleString() }} results on {{ providerLabel }}
        </p>
        <p v-if="inventoryPending" class="text-xs text-muted">
          Checking installed files…
        </p>
        <p v-else class="text-xs text-muted">
          Installed badges use verified file identities. Different builds
          published on the other source may need a manual check.
        </p>
        <UAlert
          v-if="searchError"
          color="error"
          variant="soft"
          icon="i-heroicons-exclamation-triangle"
          :description="searchError"
        />

        <div
          v-if="failedInstall"
          class="rounded-lg border border-error/40 bg-error/5 p-4 space-y-3"
          role="alert"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="space-y-1">
              <h3 class="font-semibold">
                Could not install {{ failedInstall.project.name }}
              </h3>
              <p class="text-sm">{{ failedInstall.failure.message }}</p>
              <p v-if="failedInstall.failure.hint" class="text-sm text-muted">
                {{ failedInstall.failure.hint }}
              </p>
            </div>
            <UButton
              icon="i-heroicons-x-mark-20-solid"
              variant="ghost"
              color="neutral"
              size="xs"
              aria-label="Dismiss installation error"
              @click="failedInstall = null"
            />
          </div>
          <details class="text-xs text-muted">
            <summary class="cursor-pointer">Diagnostic details</summary>
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-2">
              <template v-for="detail in failureDetails" :key="detail.label">
                <dt>{{ detail.label }}</dt>
                <dd class="font-mono break-all select-text">
                  {{ detail.value }}
                </dd>
              </template>
            </dl>
          </details>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-if="failedInstall.failure.retryable"
              size="sm"
              :disabled="Boolean(installing) || inventoryPending"
              @click="install(failedInstall.project)"
              >Retry installation</UButton
            >
            <UButton
              size="sm"
              variant="outline"
              color="neutral"
              :to="failedInstall.project.websiteUrl"
              target="_blank"
              rel="noopener noreferrer"
              icon="i-heroicons-arrow-top-right-on-square-16-solid"
              >Open source page</UButton
            >
          </div>
        </div>

        <div
          v-if="searching && !results.length"
          class="py-12 text-center text-muted"
          role="status"
        >
          <UIcon
            name="i-heroicons-arrow-path-20-solid"
            class="size-6 animate-spin"
          /><span class="sr-only">Searching</span>
        </div>
        <div
          v-else-if="results.length"
          class="divide-y divide-default rounded-lg border border-default"
        >
          <div
            v-for="hit in results"
            :key="modProjectKey(hit.provider, hit.projectId)"
            class="flex items-center gap-3 p-4 hover:bg-elevated/40"
          >
            <img
              v-if="hit.iconUrl"
              :src="hit.iconUrl"
              alt=""
              class="size-12 rounded shrink-0 object-cover"
              loading="lazy"
            />
            <UIcon
              v-else
              name="i-heroicons-puzzle-piece-20-solid"
              class="size-10 shrink-0 text-muted"
            />
            <div class="flex-1 min-w-0 space-y-1">
              <a
                :href="hit.websiteUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="font-semibold hover:text-primary hover:underline"
                >{{ hit.name }}
                <UIcon
                  name="i-heroicons-arrow-top-right-on-square-16-solid"
                  class="size-3 inline-block"
              /></a>
              <p class="text-xs text-muted line-clamp-2">
                {{ hit.description }}
              </p>
              <p class="text-xs text-dimmed">
                {{ formatDownloads(hit.downloads) }} downloads
              </p>
            </div>
            <UButton
              v-if="
                installedKeys.has(modProjectKey(hit.provider, hit.projectId))
              "
              size="sm"
              variant="soft"
              color="success"
              icon="i-heroicons-check-20-solid"
              disabled
              >Installed</UButton
            >
            <UButton
              v-else
              size="sm"
              icon="i-heroicons-plus-20-solid"
              :loading="
                installing === modProjectKey(hit.provider, hit.projectId)
              "
              :disabled="Boolean(installing) || inventoryPending"
              @click="install(hit)"
              >Install</UButton
            >
          </div>
        </div>
        <p
          v-else-if="searched && !searchError"
          class="py-12 text-center text-sm text-muted"
        >
          No compatible {{ kindLabel.toLowerCase() }} found{{
            query.trim() ? ` for “${query.trim()}”` : ""
          }}.
        </p>

        <UButton
          v-if="hasMore && results.length"
          block
          variant="ghost"
          color="neutral"
          :loading="searching"
          @click="search(true)"
          >Load more</UButton
        >
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import type {
  ModInventory,
  ModInstallFailure,
  ModProject,
  ModProvider,
  ModSearchResponse,
  ModSearchSort,
} from "#shared/types/mods";
import { modInstallFailure, modProjectKey } from "#shared/utils/mods";
import { errorMessage } from "~/utils/errors";

const props = defineProps<{
  installedProjectKeys: Set<string>;
  providers: ModInventory["providers"];
  inventoryPending: boolean;
  restart: boolean;
  kindLabel: string;
}>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ installed: [] }>();
const { id, server, refresh: refreshServer } = useServerDetail();
const toast = useToast();
const provider = ref<ModProvider>("modrinth");
const providerLabel = computed(() =>
  provider.value === "modrinth" ? "Modrinth" : "CurseForge"
);
const providerOptions = [
  { label: "Modrinth", value: "modrinth" },
  { label: "CurseForge", value: "curseforge" },
];
const providerAvailable = computed(
  () =>
    provider.value === "modrinth" ||
    props.providers.find((source) => source.id === provider.value)
      ?.available !== false
);
const providerReason = computed(
  () =>
    props.providers.find((source) => source.id === provider.value)?.reason ??
    "Ask an administrator to configure the CurseForge API key in Admin → Secrets."
);
const query = ref("");
const sort = ref<ModSearchSort>("relevance");
const sortOptions = [
  { label: "Relevance", value: "relevance" },
  { label: "Downloads", value: "downloads" },
  { label: "Recently updated", value: "updated" },
  { label: "Newest", value: "newest" },
];
const isModpackServer = computed(
  () => server.value?.config?.type === "AUTO_CURSEFORGE"
);
const loaderOverride = ref("auto");
const loaderOptions = [
  { label: "Auto-detect", value: "auto" },
  { label: "Forge", value: "forge" },
  { label: "NeoForge", value: "neoforge" },
  { label: "Fabric", value: "fabric" },
];
const results = ref<ModProject[]>([]);
const searchMeta = ref<ModSearchResponse | null>(null);
const searched = ref(false);
const searching = ref(false);
const searchError = ref("");
const nextOffset = ref(0);
const hasMore = ref(false);
let generation = 0;
let searchController: AbortController | undefined;

function cancelSearch() {
  generation++;
  searchController?.abort();
  searching.value = false;
}

async function search(append = false) {
  if (!open.value || !providerAvailable.value || (append && searching.value))
    return;
  cancelSearch();
  const requestGeneration = generation;
  searchController = new AbortController();
  searching.value = true;
  searchError.value = "";
  if (!append) {
    results.value = [];
    searchMeta.value = null;
    nextOffset.value = 0;
    hasMore.value = false;
  }
  try {
    const response = await $fetch<ModSearchResponse>(
      `/api/server/${id.value}/mods/search`,
      {
        signal: searchController.signal,
        query: {
          provider: provider.value,
          query: query.value.trim(),
          sort: sort.value,
          offset: append ? nextOffset.value : 0,
          ...(loaderOverride.value !== "auto"
            ? { loader: loaderOverride.value }
            : {}),
        },
      }
    );
    if (requestGeneration !== generation) return;
    const previous = append ? results.value : [];
    const unique = new Map(
      [...previous, ...response.hits].map((hit) => [
        modProjectKey(hit.provider, hit.projectId),
        hit,
      ])
    );
    results.value = [...unique.values()];
    searchMeta.value = response;
    nextOffset.value = response.offset + response.hits.length;
    hasMore.value =
      response.hits.length > 0 && nextOffset.value < response.total;
    searched.value = true;
  } catch (error) {
    if (requestGeneration !== generation) return;
    const failure = modInstallFailure(error);
    searchError.value = failure
      ? [failure.message, failure.hint].filter(Boolean).join(" ")
      : errorMessage(error, "Search failed.");
  } finally {
    if (requestGeneration === generation) searching.value = false;
  }
}

// Invalidate immediately when input changes, before the debounced request starts.
watch(
  [query, provider, sort, loaderOverride],
  () => {
    cancelSearch();
    results.value = [];
    searchError.value = "";
    searched.value = false;
    searchMeta.value = null;
    hasMore.value = false;
  },
  { flush: "sync" }
);
watchDebounced(query, () => search(), { debounce: 300 });
watch([provider, sort, loaderOverride, providerAvailable], () => search());
watch(open, (isOpen) => {
  cancelSearch();
  if (isOpen) {
    query.value = "";
    searchError.value = "";
    recentlyInstalled.value = new Set();
    search();
  }
});
watch(id, () => {
  open.value = false;
  cancelSearch();
  recentlyInstalled.value = new Set();
  failedInstall.value = null;
});
onBeforeUnmount(cancelSearch);

const installing = ref<string | null>(null);
const failedInstall = ref<{
  project: ModProject;
  failure: ModInstallFailure;
} | null>(null);
const failureDetails = computed(() => {
  const failure = failedInstall.value?.failure;
  if (!failure) return [];
  const stages = {
    search: "Searching projects",
    identify: "Checking installed files",
    resolve: "Resolving compatible builds and dependencies",
    download: "Downloading and verifying files",
    write: "Writing files to the server",
  };
  return [
    {
      label: "Provider",
      value: failure.provider === "curseforge" ? "CurseForge" : "Modrinth",
    },
    { label: "Step", value: failure.stage ? stages[failure.stage] : undefined },
    { label: "File", value: failure.filename },
    { label: "Project ID", value: failure.projectId },
    { label: "Host", value: failure.host },
    { label: "Upstream HTTP status", value: failure.upstreamStatus },
    { label: "Network error", value: failure.networkCode },
    { label: "Error code", value: failure.code },
    { label: "Reference ID", value: failure.requestId },
  ].filter((detail) => detail.value !== undefined);
});
const recentlyInstalled = ref(new Set<string>());
const installedKeys = computed(
  () => new Set([...props.installedProjectKeys, ...recentlyInstalled.value])
);
async function install(hit: ModProject) {
  if (
    installing.value ||
    installedKeys.value.has(modProjectKey(hit.provider, hit.projectId))
  )
    return;
  const installServerId = id.value;
  const key = modProjectKey(hit.provider, hit.projectId);
  failedInstall.value = null;
  installing.value = key;
  try {
    const result = await $fetch<{
      added: {
        filename: string;
        version_number: string;
        dependency: boolean;
      }[];
      restarted: boolean;
    }>(`/api/server/${installServerId}/mods/install`, {
      method: "POST",
      body: {
        provider: hit.provider,
        project: hit.projectId,
        restart: props.restart,
        ...(loaderOverride.value !== "auto"
          ? { loader: loaderOverride.value }
          : {}),
      },
    });
    if (installServerId !== id.value) return;
    recentlyInstalled.value = new Set([...recentlyInstalled.value, key]);
    const dependencies = result.added.filter((file) => file.dependency).length;
    toast.add({
      title: `${hit.name} installed`,
      description:
        (dependencies
          ? `Including ${dependencies} required dependencies. `
          : "") +
        (result.restarted
          ? "The server is restarting."
          : "It loads on the next server start."),
      color: "success",
    });
    emit("installed");
    if (result.restarted) await refreshServer();
  } catch (error) {
    if (installServerId !== id.value) return;
    const failure = modInstallFailure(error) ?? {
      code: "INSTALL_FAILED",
      provider: hit.provider,
      message: errorMessage(error, "Installation failed."),
      retryable: false,
    };
    failedInstall.value = { project: hit, failure };
    toast.add({
      title: `Could not install ${hit.name}`,
      description: failure.message,
      color: "error",
    });
    emit("installed"); // Refresh stale installed badges after a duplicate rejection, too.
  } finally {
    installing.value = null;
  }
}
function formatDownloads(count: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}
</script>
