<template>
  <UCard v-if="!supported">
    <div class="text-sm text-muted py-10 text-center space-y-2">
      <UIcon name="i-heroicons-folder" class="size-8 mx-auto opacity-60" />
      <p class="font-medium text-highlighted">
        File editing isn't available for this server type.
      </p>
      <p class="max-w-md mx-auto">
        The file manager covers plugin and mod setups, including modpack
        servers.
      </p>
    </div>
  </UCard>

  <ServerDetailFileManager v-else />
</template>

<script setup lang="ts">
const { server } = useServerDetail();

// Mirrors serverTypeSupportsJars() on the server; the file API rejects the rest.
const SUPPORTED = [
  "PAPER",
  "FABRIC",
  "FORGE",
  "NEOFORGE",
  "AUTO_CURSEFORGE",
  "MODRINTH",
  "FTBA",
];
const supported = computed(() =>
  SUPPORTED.includes(server.value?.config?.type ?? "")
);
</script>
