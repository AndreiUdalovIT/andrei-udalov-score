-- Keep the trigger installation and baseline atomic with match writes.
LOCK TABLE "public"."matches" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "match_observations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "match_observations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"match_id" integer NOT NULL,
	"competition_id" integer NOT NULL,
	"season" integer NOT NULL,
	"matchday" integer,
	"stage" text NOT NULL,
	"utc_date" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"home_team_id" integer,
	"away_team_id" integer,
	"home_goals" integer,
	"away_goals" integer,
	"home_goals90" integer,
	"away_goals90" integer,
	"duration" text NOT NULL,
	"home_penalties" integer,
	"away_penalties" integer,
	"last_updated" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "match_observations_source_check" CHECK ("match_observations"."source" in ('baseline', 'change')),
	CONSTRAINT "match_observations_observed_at_check" CHECK (isfinite("match_observations"."observed_at"))
);

--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "match_observations_lookup_idx" ON "match_observations" USING btree ("match_id","observed_at","id");
--> statement-breakpoint
CREATE INDEX "match_observations_scope_idx" ON "match_observations" USING btree ("competition_id","season","observed_at","match_id");
--> statement-breakpoint
CREATE FUNCTION "public"."capture_match_observation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  INSERT INTO "public"."match_observations" (
    "match_id",
    "competition_id",
    "season",
    "matchday",
    "stage",
    "utc_date",
    "status",
    "home_team_id",
    "away_team_id",
    "home_goals",
    "away_goals",
    "home_goals90",
    "away_goals90",
    "duration",
    "home_penalties",
    "away_penalties",
    "last_updated",
    "source"
  ) VALUES (
    NEW."id",
    NEW."competition_id",
    NEW."season",
    NEW."matchday",
    NEW."stage",
    NEW."utc_date",
    NEW."status",
    NEW."home_team_id",
    NEW."away_team_id",
    NEW."home_goals",
    NEW."away_goals",
    NEW."home_goals90",
    NEW."away_goals90",
    NEW."duration",
    NEW."home_penalties",
    NEW."away_penalties",
    NEW."last_updated",
    'change'
  );

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "matches_observation_trigger"
AFTER INSERT OR UPDATE ON "public"."matches"
FOR EACH ROW EXECUTE FUNCTION "public"."capture_match_observation"();
--> statement-breakpoint
-- Existing data becomes observed when collection starts.
INSERT INTO "public"."match_observations" (
  "match_id",
  "competition_id",
  "season",
  "matchday",
  "stage",
  "utc_date",
  "status",
  "home_team_id",
  "away_team_id",
  "home_goals",
  "away_goals",
  "home_goals90",
  "away_goals90",
  "duration",
  "home_penalties",
  "away_penalties",
  "last_updated",
  "source"
)
SELECT
  "id",
  "competition_id",
  "season",
  "matchday",
  "stage",
  "utc_date",
  "status",
  "home_team_id",
  "away_team_id",
  "home_goals",
  "away_goals",
  "home_goals90",
  "away_goals90",
  "duration",
  "home_penalties",
  "away_penalties",
  "last_updated",
  'baseline'
FROM "public"."matches";
