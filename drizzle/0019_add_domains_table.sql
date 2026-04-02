CREATE TABLE `domain` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `subdomain` text NOT NULL,
  `root_domain` text NOT NULL,
  `zone_id` text NOT NULL,
  `mx_record_ids` text,
  `txt_record_id` text,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` integer NOT NULL,
  `created_by` text REFERENCES user(id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_name_unique` ON `domain` (`name`);
--> statement-breakpoint
CREATE INDEX `domain_status_idx` ON `domain` (`status`);
--> statement-breakpoint
CREATE INDEX `domain_created_by_idx` ON `domain` (`created_by`);
