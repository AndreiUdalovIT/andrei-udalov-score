CREATE TABLE "season_forecasts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "season_forecasts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"competition_id" integer NOT NULL,
	"season" integer NOT NULL,
	"kind" text NOT NULL,
	"model_version" text NOT NULL,
	"data_cutoff" timestamp with time zone NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"seed" bigint[4] NOT NULL,
	"runs" integer NOT NULL,
	"forecast" jsonb NOT NULL,
	CONSTRAINT "season_forecasts_kind_check" CHECK ("season_forecasts"."kind" in ('league-table', 'champions-league-stages')),
	CONSTRAINT "season_forecasts_version_check" CHECK (btrim("season_forecasts"."model_version") <> ''),
	CONSTRAINT "season_forecasts_season_runs_check" CHECK ("season_forecasts"."season" > 0 and "season_forecasts"."runs" > 0),
	CONSTRAINT "season_forecasts_times_check" CHECK (isfinite("season_forecasts"."data_cutoff") and isfinite("season_forecasts"."calculated_at") and isfinite("season_forecasts"."recorded_at")
        and "season_forecasts"."data_cutoff" <= "season_forecasts"."calculated_at" and "season_forecasts"."calculated_at" <= "season_forecasts"."recorded_at"),
	CONSTRAINT "season_forecasts_seed_check" CHECK (case when array_ndims("season_forecasts"."seed") = 1 then
        array_lower("season_forecasts"."seed", 1) = 1 and cardinality("season_forecasts"."seed") = 4
        and array_position("season_forecasts"."seed", null) is null
        and 0 <= all("season_forecasts"."seed") and 4294967295 >= all("season_forecasts"."seed")
        and 0 < any("season_forecasts"."seed")
        else false end),
	CONSTRAINT "season_forecasts_payload_check" CHECK (jsonb_typeof("season_forecasts"."forecast") = 'object')
);
--> statement-breakpoint
ALTER TABLE "season_forecasts" ADD CONSTRAINT "season_forecasts_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "season_forecasts_lookup_idx" ON "season_forecasts" USING btree ("competition_id","season","kind","data_cutoff","calculated_at","id");
