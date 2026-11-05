<template>
  <div class="min-w-0 space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <UInput
        v-model="query"
        icon="i-heroicons-magnifying-glass-20-solid"
        placeholder="Search name, filename or version…"
        aria-label="Search installed files"
        class="min-w-0 flex-1 basis-56"
      />
      <USelect
        v-model="source"
        :items="sourceOptions"
        aria-label="Filter by mod source"
        class="w-40"
      />
      <USelect
        v-model="availableOn"
        :items="availabilityOptions"
        aria-label="Filter by available listings"
        class="w-40"
      />
      <USelect
        v-model="status"
        :items="statusOptions"
        aria-label="Filter by status"
        class="w-44"
      />
    </div>
    <p class="text-xs text-muted" aria-live="polite">
      {{ visible.length }} of {{ mods.length }} installed ·
      {{ selected.length }} selected
    </p>
    <div class="overflow-x-auto rounded-lg border border-default">
      <table class="w-full min-w-[44rem] table-fixed text-sm text-left">
        <colgroup>
          <col class="w-9" />
          <col />
          <col class="w-32" />
          <col class="w-28" />
          <col class="w-32" />
          <col class="w-22" />
          <col class="w-10" />
        </colgroup>
        <thead class="bg-elevated/50 text-muted text-xs">
          <tr>
            <th class="px-2 py-3">
              <UCheckbox
                :model-value="
                  allSelected ? true : someSelected ? 'indeterminate' : false
                "
                aria-label="Select all visible mods"
                @update:model-value="toggleAll"
              />
            </th>
            <th
              v-for="column in columns"
              :key="column.key"
              :aria-sort="
                sortKey === column.key
                  ? descending
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              "
              class="px-2 py-3 whitespace-nowrap"
            >
              <button
                type="button"
                class="inline-flex items-center gap-1 cursor-pointer hover:text-highlighted focus-visible:outline-primary"
                @click="sortBy(column.key)"
              >
                {{ column.label }}
                <UIcon
                  v-if="sortKey === column.key"
                  :name="
                    descending
                      ? 'i-heroicons-chevron-down-20-solid'
                      : 'i-heroicons-chevron-up-20-solid'
                  "
                  class="size-3"
                />
              </button>
            </th>
            <th class="px-2 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="mod in visible"
            :key="mod.filename"
            class="hover:bg-elevated/40"
            :class="{ 'bg-primary/5': selected.includes(mod.filename) }"
          >
            <td class="px-2 py-3">
              <UCheckbox
                :model-value="selected.includes(mod.filename)"
                :aria-label="`Select ${mod.filename}`"
                @update:model-value="toggle(mod.filename)"
              />
            </td>
            <td class="px-2 py-3">
              <div class="flex min-w-0 items-center gap-2">
                <img
                  v-if="mod.displayIdentity?.iconUrl"
                  :src="mod.displayIdentity.iconUrl"
                  alt=""
                  class="size-9 rounded object-cover shrink-0"
                  loading="lazy"
                />
                <UIcon
                  v-else
                  name="i-heroicons-puzzle-piece-20-solid"
                  class="size-8 shrink-0 text-muted"
                />
                <div class="min-w-0">
                  <a
                    v-if="mod.pageUrl"
                    :href="mod.pageUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="font-medium text-highlighted [overflow-wrap:anywhere] hover:text-primary hover:underline"
                    >{{ mod.displayIdentity?.name }}</a
                  >
                  <span
                    v-else
                    class="font-medium text-highlighted [overflow-wrap:anywhere]"
                    >{{ mod.displayIdentity?.name ?? mod.filename }}</span
                  >
                  <p
                    v-if="mod.identities.length"
                    class="text-xs text-muted font-mono truncate"
                    :title="mod.filename"
                  >
                    {{ mod.filename }}
                  </p>
                  <div
                    class="flex flex-wrap gap-1 mt-1"
                    v-if="
                      mod.dependency || mod.managed || updates[mod.filename]
                    "
                  >
                    <UTooltip
                      v-if="mod.dependency"
                      :content="{ side: 'top', align: 'start' }"
                      :ui="{
                        content:
                          'z-50 block h-auto w-80 max-w-[calc(100vw-2rem)] rounded-lg bg-default p-0 text-sm text-highlighted shadow-xl ring ring-default',
                      }"
                    >
                      <UBadge
                        as="button"
                        type="button"
                        size="xs"
                        color="info"
                        variant="soft"
                        :aria-label="dependencyDescription(mod)"
                        class="cursor-help focus-visible:outline-primary"
                        >Dependency</UBadge
                      >
                      <template #content>
                        <div class="whitespace-normal">
                          <div
                            class="flex items-center justify-between gap-3 border-b border-default px-4 py-3"
                          >
                            <p class="font-semibold">Required by</p>
                            <UBadge size="xs" color="neutral" variant="soft">
                              {{ mod.requiredBy.length }}
                            </UBadge>
                          </div>
                          <ul
                            v-if="mod.requiredBy.length"
                            class="max-h-60 overflow-y-auto divide-y divide-default"
                          >
                            <li
                              v-for="parent in mod.requiredBy"
                              :key="parent.filename"
                              class="px-4 py-3 break-words"
                            >
                              <p class="font-medium">{{ parent.name }}</p>
                              <p
                                v-if="parent.name !== parent.filename"
                                class="mt-1 font-mono text-xs text-muted"
                              >
                                {{ parent.filename }}
                              </p>
                            </li>
                          </ul>
                          <p v-else class="px-4 py-3 text-muted">
                            No installed mods currently require this dependency.
                          </p>
                        </div>
                      </template>
                    </UTooltip>
                    <UBadge
                      v-if="mod.packManaged"
                      size="xs"
                      color="neutral"
                      variant="soft"
                      >Modpack</UBadge
                    >
                    <UBadge
                      v-else-if="mod.managed"
                      size="xs"
                      color="neutral"
                      variant="soft"
                      >Auto-install</UBadge
                    >
                    <UButton
                      v-else-if="updates[mod.filename]"
                      icon="i-heroicons-arrow-path-20-solid"
                      size="xs"
                      color="warning"
                      variant="soft"
                      :disabled="updating"
                      :aria-label="`Update ${mod.displayIdentity?.name ?? mod.filename} to ${updates[mod.filename]!.latestVersion}`"
                      class="min-w-0 max-w-full text-left whitespace-normal [overflow-wrap:anywhere]"
                      @click="emit('update-mod', mod.filename)"
                    >
                      Update: {{ updates[mod.filename]!.latestVersion }}
                    </UButton>
                  </div>
                </div>
              </div>
            </td>
            <td class="px-2 py-3">
              <span
                class="line-clamp-2 [overflow-wrap:anywhere]"
                :title="mod.displayIdentity?.version"
                >{{ mod.displayIdentity?.version ?? "Unknown" }}</span
              >
            </td>
            <td class="px-2 py-3 whitespace-nowrap text-muted">
              <time
                v-if="mod.modifiedAt"
                :datetime="mod.modifiedAt"
                :title="new Date(mod.modifiedAt).toLocaleString()"
                >{{ new Date(mod.modifiedAt).toLocaleDateString() }}</time
              ><span v-else>—</span>
            </td>
            <td class="px-2 py-3">
              <span
                class="inline-flex min-w-0 items-center gap-1.5 text-xs"
                :class="{
                  'text-muted': mod.source === 'unknown' && !mod.packManaged,
                }"
                :title="
                  mod.packManaged
                    ? 'This file is managed by the modpack installer.'
                    : mod.source === 'unknown'
                      ? 'No recorded installation source for this file.'
                      : undefined
                "
              >
                <img
                  v-if="
                    mod.packManaged ||
                    mod.source === 'modrinth' ||
                    mod.source === 'curseforge'
                  "
                  :src="
                    mod.packManaged
                      ? mod.packPlatform === 'ftb'
                        ? ftbIcon
                        : mod.packPlatform === 'modrinth'
                          ? modrinthIcon
                          : curseforgeIcon
                      : mod.source === 'modrinth'
                        ? modrinthIcon
                        : curseforgeIcon
                  "
                  alt=""
                  class="size-3.5"
                />
                <UIcon
                  v-else
                  :name="
                    mod.source === 'manual'
                      ? 'i-heroicons-arrow-up-tray-20-solid'
                      : 'i-heroicons-question-mark-circle-20-solid'
                  "
                  class="size-3.5"
                />
                {{ installedModSourceLabel(mod) }}
              </span>
            </td>
            <td class="px-2 py-3 whitespace-nowrap text-muted">
              {{ (mod.size / 1024 / 1024).toFixed(2) }} MiB
            </td>
            <td class="px-2 py-3">
              <UDropdownMenu
                :items="rowMenuItems(mod)"
                :content="{ align: 'end' }"
              >
                <UButton
                  icon="i-heroicons-ellipsis-vertical-20-solid"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  :aria-label="`Actions for ${mod.filename}`"
                />
                <template #modrinth-leading>
                  <img :src="modrinthIcon" alt="" class="size-4 shrink-0" />
                </template>
                <template #curseforge-leading>
                  <img :src="curseforgeIcon" alt="" class="size-4 shrink-0" />
                </template>
              </UDropdownMenu>
            </td>
          </tr>
          <tr v-if="!visible.length">
            <td colspan="7" class="p-10 text-center text-muted">
              {{
                mods.length
                  ? "No mods match these filters."
                  : "No mods or plugins installed yet."
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type {
  InstalledMod,
  ModIdentity,
  ModOrigin,
  ModProvider,
} from "#shared/types/mods";
import {
  filterInstalledMods,
  installedModLinkIdentity,
  modSourceLabel,
  installedModSourceLabel,
} from "#shared/utils/mods";
import modrinthIcon from "~/assets/modrinth.svg";
import curseforgeIcon from "~/assets/curseforge.svg";
import ftbIcon from "~/assets/ftb.svg";

const props = defineProps<{
  mods: InstalledMod[];
  updates: Record<string, { latestVersion: string; managed: boolean }>;
  menuItems: (mod: InstalledMod) => DropdownMenuItem[];
  updating?: boolean;
}>();
const emit = defineEmits<{ "update-mod": [filename: string] }>();
const selected = defineModel<string[]>("selected", { required: true });
const query = ref("");
const source = ref<"all" | ModOrigin | "ftb">("all");
const availableOn = ref<"all" | "unknown" | ModProvider>("all");
const status = ref("all");
const sourceOptions = [
  { label: "All sources", value: "all" },
  { label: "Modrinth", value: "modrinth" },
  { label: "CurseForge", value: "curseforge" },
  { label: "FTB modpack", value: "ftb" },
  { label: "Manual upload", value: "manual" },
  { label: "Unknown", value: "unknown" },
];
const availabilityOptions = [
  { label: "All listings", value: "all" },
  { label: "Modrinth", value: "modrinth" },
  { label: "CurseForge", value: "curseforge" },
  { label: "Not identified", value: "unknown" },
];
const statusOptions = [
  { label: "All statuses", value: "all" },
  { label: "Modpack files", value: "modpack" },
  { label: "Custom additions", value: "custom" },
  { label: "Update available", value: "updates" },
  { label: "Auto-install", value: "managed" },
  { label: "Dependencies", value: "dependencies" },
];
function rowMenuItems(mod: InstalledMod): DropdownMenuItem[][] {
  const listings: DropdownMenuItem[] = mod.identities.map((identity) => ({
    label: modSourceLabel(identity.provider),
    slot: identity.provider,
    to: identity.websiteUrl,
    external: true,
    target: "_blank",
    rel: "noopener noreferrer",
  }));
  return [
    props.menuItems(mod),
    [
      { type: "label", label: "Available on" },
      ...(listings.length
        ? listings
        : [{ label: "Not identified", disabled: true }]),
    ],
  ];
}
function dependencyDescription(mod: InstalledMod) {
  return mod.requiredBy.length
    ? `Dependency. Required by: ${mod.requiredBy.map((parent) => parent.name).join(", ")}`
    : "Dependency. No installed mods currently require this dependency.";
}
type SortKey = "name" | "version" | "modifiedAt" | "source" | "size";
const columns: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "version", label: "Version" },
  { key: "modifiedAt", label: "Modified" },
  { key: "source", label: "Source" },
  { key: "size", label: "Size" },
];
const sortKey = ref<SortKey>("name");
const descending = ref(false);
function sortBy(key: SortKey) {
  if (sortKey.value === key) descending.value = !descending.value;
  else {
    sortKey.value = key;
    descending.value = key === "modifiedAt";
  }
}
type ModRow = InstalledMod & {
  displayIdentity: ModIdentity | undefined;
  pageUrl: string | undefined;
};
function sortValue(mod: ModRow): string | number {
  switch (sortKey.value) {
    case "name":
      return mod.displayIdentity?.name ?? mod.filename;
    case "version":
      return mod.displayIdentity?.version ?? "";
    case "modifiedAt":
      return mod.modifiedAt ? Date.parse(mod.modifiedAt) : 0;
    case "source":
      return installedModSourceLabel(mod);
    case "size":
      return mod.size;
  }
}
const visible = computed<ModRow[]>(() =>
  filterInstalledMods(props.mods, query.value, availableOn.value, source.value)
    .filter(
      (mod) =>
        status.value === "all" ||
        (status.value === "modpack"
          ? Boolean(mod.packManaged)
          : status.value === "custom"
            ? !mod.packManaged
            : status.value === "managed"
              ? mod.managed
              : status.value === "dependencies"
                ? mod.dependency
                : Boolean(props.updates[mod.filename] && !mod.managed))
    )
    .map((mod) => {
      const linkIdentity = installedModLinkIdentity(mod);
      return {
        ...mod,
        displayIdentity: linkIdentity ?? mod.identities[0],
        pageUrl: linkIdentity?.websiteUrl,
      };
    })
    .sort((a, b) => {
      const left = sortValue(a),
        right = sortValue(b);
      const comparison =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), undefined, {
              numeric: true,
              sensitivity: "base",
            });
      return (
        (comparison || a.filename.localeCompare(b.filename)) *
        (descending.value ? -1 : 1)
      );
    })
);
const allSelected = computed(
  () =>
    visible.value.length > 0 &&
    visible.value.every((mod) => selected.value.includes(mod.filename))
);
const someSelected = computed(() =>
  visible.value.some((mod) => selected.value.includes(mod.filename))
);
function toggle(filename: string) {
  selected.value = selected.value.includes(filename)
    ? selected.value.filter((name) => name !== filename)
    : [...selected.value, filename];
}
function toggleAll() {
  const names = new Set(visible.value.map((mod) => mod.filename));
  selected.value = allSelected.value
    ? selected.value.filter((name) => !names.has(name))
    : [...new Set([...selected.value, ...names])];
}
watch(
  () => props.mods,
  (mods) => {
    const names = new Set(mods.map((mod) => mod.filename));
    selected.value = selected.value.filter((name) => names.has(name));
  }
);
</script>
