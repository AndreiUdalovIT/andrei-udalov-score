ALTER TABLE "scorers" ALTER COLUMN "assists" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "scorers" ALTER COLUMN "assists" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "scorers" ALTER COLUMN "penalties" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "scorers" ALTER COLUMN "penalties" DROP NOT NULL;
