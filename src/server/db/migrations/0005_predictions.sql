CREATE TABLE "predictions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "predictions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"match_id" integer NOT NULL,
	"source" text NOT NULL,
	"model_version" text NOT NULL,
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"kickoff_at" timestamp with time zone NOT NULL,
	"data_cutoff" timestamp with time zone NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"published_at" timestamp with time zone,
	"expected_goals" jsonb NOT NULL,
	"probabilities" jsonb NOT NULL,
	"model_options" jsonb NOT NULL,
	CONSTRAINT "predictions_source_check" CHECK ("predictions"."source" in ('published', 'backtest')),
	CONSTRAINT "predictions_version_check" CHECK (btrim("predictions"."model_version") <> ''),
	CONSTRAINT "predictions_teams_check" CHECK ("predictions"."home_team_id" <> "predictions"."away_team_id"),
	CONSTRAINT "predictions_finite_times_check" CHECK (isfinite("predictions"."kickoff_at") and isfinite("predictions"."data_cutoff")
        and isfinite("predictions"."calculated_at") and isfinite("predictions"."recorded_at")),
	CONSTRAINT "predictions_timing_check" CHECK ("predictions"."data_cutoff" <= "predictions"."calculated_at"
        and "predictions"."calculated_at" <= "predictions"."recorded_at"
        and "predictions"."data_cutoff" <= "predictions"."kickoff_at"),
	CONSTRAINT "predictions_publication_check" CHECK ((
        "predictions"."source" = 'published' and "predictions"."published_at" is not null
        and "predictions"."published_at" = "predictions"."recorded_at"
        and "predictions"."published_at" < "predictions"."kickoff_at"
      ) or (
        "predictions"."source" = 'backtest' and "predictions"."published_at" is null
      )),
	CONSTRAINT "predictions_payload_objects_check" CHECK (jsonb_typeof("predictions"."expected_goals") = 'object'
        and jsonb_typeof("predictions"."probabilities") = 'object'
        and jsonb_typeof("predictions"."model_options") = 'object')
);
--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "predictions_fixture_cutoff_idx" ON "predictions" USING btree ("match_id","source","model_version","home_team_id","away_team_id","kickoff_at","data_cutoff");--> statement-breakpoint
CREATE INDEX "predictions_lookup_idx" ON "predictions" USING btree ("match_id","source","model_version","data_cutoff","recorded_at","id");
