CREATE TABLE "standings_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "standings_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"competition_id" integer NOT NULL,
	"season" integer NOT NULL,
	"source" text NOT NULL,
	"matchday" integer,
	"captured_at" timestamp with time zone NOT NULL,
	"rows" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "standings_snapshots" ADD CONSTRAINT "standings_snapshots_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standings_snapshots_lookup_idx" ON "standings_snapshots" USING btree ("competition_id","season","source","matchday","captured_at","id");
