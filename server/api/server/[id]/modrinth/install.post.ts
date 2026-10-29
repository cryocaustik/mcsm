import { installServerMod } from "../../../../utils/mods/installation";

/** Retain the legacy route while sharing dependency tracking and duplicate checks. */
export default defineEventHandler((event) =>
  installServerMod(event, "modrinth")
);
