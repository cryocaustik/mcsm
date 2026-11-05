CREATE TABLE `modpack_operations` (
	`volume` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`operation` text NOT NULL,
	`previous_config` text NOT NULL
);
