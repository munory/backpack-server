CREATE SEQUENCE "public"."sync_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "categories" (
	"user_id" uuid NOT NULL,
	"uuid" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_uuid" uuid,
	"pack_type" smallint NOT NULL,
	"icon" text,
	"color" text,
	"updated_at" bigint NOT NULL,
	"server_seq" bigint DEFAULT nextval('sync_seq') NOT NULL,
	CONSTRAINT "categories_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "deletions" (
	"user_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_key" text NOT NULL,
	"deleted_at" bigint NOT NULL,
	"server_seq" bigint DEFAULT nextval('sync_seq') NOT NULL,
	CONSTRAINT "deletions_user_id_entity_entity_key_pk" PRIMARY KEY("user_id","entity","entity_key")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"user_id" uuid NOT NULL,
	"uuid" uuid NOT NULL,
	"name" text NOT NULL,
	"weight_grams" integer NOT NULL,
	"category_uuid" uuid,
	"condition" smallint NOT NULL,
	"pack_type" smallint,
	"quantity" integer DEFAULT 1 NOT NULL,
	"worn" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	"server_seq" bigint DEFAULT nextval('sync_seq') NOT NULL,
	CONSTRAINT "items_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "trip_items" (
	"user_id" uuid NOT NULL,
	"trip_uuid" uuid NOT NULL,
	"item_uuid" uuid NOT NULL,
	"quantity" integer,
	"in_bag" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	"server_seq" bigint DEFAULT nextval('sync_seq') NOT NULL,
	CONSTRAINT "trip_items_user_id_trip_uuid_item_uuid_pk" PRIMARY KEY("user_id","trip_uuid","item_uuid")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"user_id" uuid NOT NULL,
	"uuid" uuid NOT NULL,
	"name" text NOT NULL,
	"target_weight_grams" integer,
	"created_at_ms" bigint NOT NULL,
	"start_date" bigint,
	"end_date" bigint,
	"is_draft" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	"server_seq" bigint DEFAULT nextval('sync_seq') NOT NULL,
	CONSTRAINT "trips_user_id_uuid_pk" PRIMARY KEY("user_id","uuid")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"google_id" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletions" ADD CONSTRAINT "deletions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_items" ADD CONSTRAINT "trip_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_changes_idx" ON "categories" USING btree ("user_id","server_seq");--> statement-breakpoint
CREATE INDEX "deletions_changes_idx" ON "deletions" USING btree ("user_id","server_seq");--> statement-breakpoint
CREATE INDEX "items_changes_idx" ON "items" USING btree ("user_id","server_seq");--> statement-breakpoint
CREATE INDEX "password_resets_user_idx" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trip_items_changes_idx" ON "trip_items" USING btree ("user_id","server_seq");--> statement-breakpoint
CREATE INDEX "trips_changes_idx" ON "trips" USING btree ("user_id","server_seq");