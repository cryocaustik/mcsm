<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <img
            v-if="data?.catalog?.iconUrl"
            :src="data.catalog.iconUrl"
            alt=""
            class="size-10 rounded object-cover"
          />
          <div class="min-w-0">
            <h3 class="font-semibold">
              {{ data?.catalog?.name ?? data?.installed?.name ?? "Modpack" }}
            </h3>
            <p class="text-xs text-muted">
              {{ platformLabel }} · Installed and updated by the server
              container
            </p>
          </div>
          <UBadge v-if="data?.updateAvailable" color="warning" variant="soft"
            >Update available</UBadge
          >
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="data?.catalog"
            :to="data.catalog.url"
            target="_blank"
            external
            color="neutral"
            variant="ghost"
            size="sm"
            trailing-icon="i-heroicons-arrow-top-right-on-square-16-solid"
            >Pack page</UButton
          >
          <UButton
            icon="i-heroicons-arrow-path-20-solid"
            color="neutral"
            variant="ghost"
            size="sm"
            :loading="versionStatus === 'pending'"
            @click="checkVersions"
            >Check versions</UButton
          >
          <UButton
            v-if="can('manager')"
            :disabled="
              !data?.catalog?.versions.length ||
              data.containerAvailable === false ||
              busy
            "
            size="sm"
            :color="data?.updateAvailable ? 'warning' : 'primary'"
            variant="soft"
            @click="openChange"
            >{{
              data?.updateAvailable ? "Update modpack" : "Change version"
            }}</UButton
          >
        </div>
      </div>
    </template>
    <div class="space-y-4">
      <UAlert
        v-if="error"
        color="warning"
        variant="soft"
        title="Modpack status is temporarily unavailable"
        :description="
          errorMessage(
            error,
            'Try checking again or inspect Console for installation output.'
          )
        "
      />
      <UAlert
        v-if="versionError"
        color="warning"
        variant="soft"
        title="Version checks are unavailable"
        :description="
          errorMessage(
            versionError,
            'Installed pack details remain available. Try checking again later.'
          )
        "
      />
      <UAlert
        v-for="warning in data?.warnings ?? []"
        :key="warning"
        color="warning"
        variant="soft"
        :description="warning"
      />
      <dl class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt class="text-xs text-muted">
            {{ data?.ready ? "Installed version" : "Recorded version" }}
          </dt>
          <dd class="mt-1 font-medium">
            {{
              data?.installed?.versionName ??
              data?.installed?.versionId ??
              "Waiting for installation"
            }}<span
              v-if="data?.installed && !data.installed.receipt"
              class="block text-xs text-muted"
              >Installer completion has not been confirmed</span
            >
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Minecraft / loader</dt>
          <dd class="mt-1">
            {{ data?.installed?.minecraft ?? "Not detected yet"
            }}<span
              v-if="data?.installed?.loader"
              class="block text-xs text-muted"
              >{{ data.installed.loader }}
              {{ data.installed.loaderVersion }}</span
            >
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Update policy</dt>
          <dd class="mt-1">
            {{
              data?.mode === "latest"
                ? "Follow latest on restart"
                : "Pinned version"
            }}<span
              v-if="
                data?.requestedVersion &&
                data.requestedVersion !== data.installed?.versionId
              "
              class="block text-xs text-muted"
              >Requested: {{ data.requestedVersion }}</span
            >
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Latest release</dt>
          <dd class="mt-1">{{ data?.latest?.name ?? "Unavailable" }}</dd>
        </div>
      </dl>
      <div
        v-if="data?.operation"
        class="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-3"
      >
        <p class="text-sm" role="status">
          {{ operationLabel
          }}<span
            v-if="data.operation.error"
            class="mt-1 block text-xs text-error"
            >{{ data.operation.error }}</span
          >
        </p>
        <UButton
          v-if="data.operation.backupId && can('manager')"
          size="xs"
          color="neutral"
          variant="outline"
          :disabled="busy && data.operation.state !== 'installing'"
          @click="rollbackOpen = true"
          >Restore pre-update backup</UButton
        >
      </div>
      <p class="text-xs text-muted">
        Pack-owned mods change with the modpack version. Custom additions remain
        independently managed.
      </p>
    </div>
  </UCard>

  <UModal
    v-model:open="changeOpen"
    title="Change modpack version"
    description="The server will stop, a full backup will be created, and the container will install the selected version."
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Update policy"
          ><USelect
            v-model="mode"
            :items="[
              {
                label: 'Pin a specific version (recommended)',
                value: 'pinned',
              },
              { label: 'Follow latest on every restart', value: 'latest' },
            ]"
            class="w-full"
        /></UFormField>
        <UFormField v-if="mode === 'pinned'" label="Modpack version"
          ><USelectMenu
            v-model="selected"
            :items="versionOptions"
            value-key="value"
            class="w-full"
            placeholder="Select a version"
        /></UFormField>
        <p v-else class="text-sm text-muted">
          Future restarts may install a newer pack according to the container's
          provider settings.
        </p>
        <p v-if="targetVersion?.minecraft.length" class="text-sm">
          Minecraft: {{ targetVersion.minecraft.join(", ") }}
        </p>
        <p class="text-xs text-muted">
          Review the pack's release notes and Java requirements before changing
          versions. Restoring the pre-update backup also restores the world to
          that point.
        </p>
      </div>
    </template>
    <template #footer
      ><div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="changeOpen = false"
          >Cancel</UButton
        ><UButton
          :loading="submitting"
          :disabled="mode === 'pinned' && !selected"
          @click="apply(false)"
          >Back up and apply</UButton
        >
      </div></template
    >
  </UModal>
  <UModal
    v-model:open="rollbackOpen"
    title="Restore pre-update modpack"
    description="This restores the full pre-update backup, including world progress, mods and configuration files, then starts the previous pinned pack version."
  >
    <template #footer
      ><div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="rollbackOpen = false"
          >Cancel</UButton
        ><UButton color="warning" :loading="submitting" @click="apply(true)"
          >Restore backup and version</UButton
        >
      </div></template
    >
  </UModal>
</template>

<script setup lang="ts">
import type {
  ModpackStatus,
  PackCatalog,
  ModpackMode,
  InstalledPack,
} from "#shared/types/modpacks";
import {
  packPlatform,
  newestPackVersion,
  packHasUpdate,
} from "#shared/utils/modpacks";
import { errorMessage } from "~/utils/errors";
const { id, server, can, refresh: refreshServer } = useServerDetail();
const emit = defineEmits<{
  changed: [];
  installed: [pack: InstalledPack | null];
}>();
const force = ref(false);
const {
  data: statusData,
  status,
  error,
  refresh,
} = useFetch<ModpackStatus | null>(() => `/api/server/${id.value}/modpack`, {
  key: computed(() => `server-modpack:${id.value}`),
  watch: false,
  lazy: true,
  retry: false,
  default: () => null,
});
const {
  data: versions,
  status: versionStatus,
  error: versionError,
  refresh: refreshVersions,
} = useFetch<PackCatalog>(() => `/api/server/${id.value}/modpack/versions`, {
  key: computed(() => `server-modpack-versions:${id.value}`),
  query: { refresh: force },
  watch: false,
  lazy: true,
  retry: false,
});
const data = computed(() => {
  if (!statusData.value) return null;
  const catalog = versions.value ?? statusData.value.catalog;
  const latest = catalog ? newestPackVersion(catalog.versions) : null;
  return {
    ...statusData.value,
    catalog,
    latest,
    updateAvailable: Boolean(
      catalog &&
      packHasUpdate(statusData.value.installed, latest, catalog.versions)
    ),
  };
});

watch(
  () => data.value?.installed,
  (pack) => emit("installed", pack ?? null),
  { immediate: true }
);
const operationStartedAt = ref<number | null>(null);
const platformLabel = computed(
  () =>
    ({ curseforge: "CurseForge", ftb: "Feed The Beast", modrinth: "Modrinth" })[
      data.value?.platform ?? packPlatform(server.value?.config) ?? "curseforge"
    ]
);
const busy = computed(
  () =>
    submitting.value ||
    localPending.value ||
    Boolean(
      data.value?.operation &&
      !["complete", "failed"].includes(data.value.operation.state)
    )
);
const changeOpen = ref(false),
  rollbackOpen = ref(false),
  submitting = ref(false),
  localPending = ref(false);
const selected = ref<string>();
const mode = ref<ModpackMode>("pinned");
const versionOptions = computed(() =>
  (data.value?.catalog?.versions ?? []).map((version) => ({
    label: `${version.name}${version.channel === "release" ? "" : ` (${version.channel})`}`,
    value: version.id,
  }))
);
const targetVersion = computed(() =>
  data.value?.catalog?.versions.find((version) => version.id === selected.value)
);
const operationLabel = computed(() => {
  const operation = data.value?.operation;
  if (!operation) return "";
  return {
    "backing-up": "Stopping server and creating a pre-update backup…",
    restoring: "Restoring the pre-update backup…",
    recreating: "Applying the container configuration…",
    installing:
      "Container started; waiting for pack installation and server readiness…",
    complete: "Modpack change completed.",
    failed: "Modpack change failed.",
  }[operation.state];
});
const toast = useToast();
function openChange() {
  mode.value = data.value?.mode ?? "pinned";
  selected.value = data.value?.updateAvailable
    ? data.value.latest?.id
    : (data.value?.installed?.versionId ?? data.value?.latest?.id);
  changeOpen.value = true;
}
async function checkVersions() {
  force.value = true;
  try {
    await Promise.all([refreshVersions(), refresh()]);
  } finally {
    force.value = false;
  }
}
async function apply(rollback: boolean) {
  submitting.value = true;
  try {
    const result = await $fetch<{ operation: { startedAt: number } }>(
      `/api/server/${id.value}/modpack`,
      {
        method: "POST",
        body: rollback
          ? { rollback: true }
          : { mode: mode.value, versionId: selected.value },
      }
    );
    operationStartedAt.value = result.operation.startedAt;
    localPending.value = true;
    changeOpen.value = false;
    rollbackOpen.value = false;
    await refresh();
  } catch (error) {
    toast.add({
      title: "Could not change modpack",
      description: errorMessage(error, "Try again."),
      color: "error",
    });
  } finally {
    submitting.value = false;
  }
}
const { pause, resume } = useIntervalFn(
  () => {
    if (status.value !== "pending" && !force.value) void refresh();
  },
  4000,
  { immediate: false }
);
watch(
  [
    () => data.value?.operation?.state,
    () => data.value?.ready,
    localPending,
    () => server.value?.running,
  ],
  ([state, ready, pending, running]) => {
    if (state === "complete" || state === "failed") {
      if (
        localPending.value &&
        data.value?.operation?.startedAt === operationStartedAt.value
      ) {
        localPending.value = false;
        if (state === "complete") emit("changed");
        else if (data.value?.containerAvailable !== false) void refreshServer();
      }
    }
    if (
      pending ||
      (state && !["complete", "failed"].includes(state)) ||
      (running && !ready)
    )
      resume();
    else pause();
  },
  { immediate: true }
);
</script>
