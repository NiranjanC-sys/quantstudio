CREATE SCHEMA "instructor";
--> statement-breakpoint
CREATE TYPE "instructor"."assignment_status" AS ENUM('not_started', 'in_progress', 'submitted', 'graded', 'excused');--> statement-breakpoint
CREATE TYPE "instructor"."cohort_member_role" AS ENUM('student', 'assistant');--> statement-breakpoint
CREATE TABLE "instructor"."assignment_grades" (
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "instructor"."assignment_status" DEFAULT 'not_started' NOT NULL,
	"score" double precision,
	"auto_score" double precision,
	"feedback" text,
	"graded_by" uuid,
	"submitted_at" timestamp with time zone,
	"graded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_grades_assignment_id_user_id_pk" PRIMARY KEY("assignment_id","user_id"),
	CONSTRAINT "assignment_grades_score_range" CHECK (("instructor"."assignment_grades"."score" is null or "instructor"."assignment_grades"."score" between 0 and 1) and ("instructor"."assignment_grades"."auto_score" is null or "instructor"."assignment_grades"."auto_score" between 0 and 1)),
	CONSTRAINT "assignment_grades_graded_has_score" CHECK (("instructor"."assignment_grades"."status" <> 'graded') or ("instructor"."assignment_grades"."score" is not null))
);
--> statement-breakpoint
CREATE TABLE "instructor"."assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cohort_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"lesson_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"points" integer DEFAULT 100 NOT NULL,
	"due_at" timestamp with time zone,
	"published" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignments_points_positive" CHECK ("instructor"."assignments"."points" > 0),
	CONSTRAINT "assignments_title_length" CHECK (length("instructor"."assignments"."title") between 2 and 200)
);
--> statement-breakpoint
CREATE TABLE "instructor"."cohort_members" (
	"cohort_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "instructor"."cohort_member_role" DEFAULT 'student' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "cohort_members_cohort_id_user_id_pk" PRIMARY KEY("cohort_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "instructor"."cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"term" text,
	"track_id" integer,
	"join_code" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cohorts_slug_shape" CHECK ("instructor"."cohorts"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "cohorts_join_code_shape" CHECK ("instructor"."cohorts"."join_code" ~ '^[A-Z0-9]{6,12}$'),
	CONSTRAINT "cohorts_name_length" CHECK (length("instructor"."cohorts"."name") between 2 and 120)
);
--> statement-breakpoint
ALTER TABLE "instructor"."assignment_grades" ADD CONSTRAINT "assignment_grades_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "instructor"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."assignment_grades" ADD CONSTRAINT "assignment_grades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."assignment_grades" ADD CONSTRAINT "assignment_grades_graded_by_users_id_fk" FOREIGN KEY ("graded_by") REFERENCES "identity"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."assignments" ADD CONSTRAINT "assignments_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "instructor"."cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."assignments" ADD CONSTRAINT "assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."cohort_members" ADD CONSTRAINT "cohort_members_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "instructor"."cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."cohort_members" ADD CONSTRAINT "cohort_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."cohorts" ADD CONSTRAINT "cohorts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "identity"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."cohorts" ADD CONSTRAINT "cohorts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor"."cohorts" ADD CONSTRAINT "cohorts_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "catalog"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_grades_user_idx" ON "instructor"."assignment_grades" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "assignments_cohort_idx" ON "instructor"."assignments" USING btree ("cohort_id","due_at");--> statement-breakpoint
CREATE INDEX "cohort_members_user_idx" ON "instructor"."cohort_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cohorts_org_slug_key" ON "instructor"."cohorts" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "cohorts_join_code_key" ON "instructor"."cohorts" USING btree ("join_code") WHERE "instructor"."cohorts"."archived" = false;--> statement-breakpoint
CREATE INDEX "cohorts_owner_idx" ON "instructor"."cohorts" USING btree ("owner_id");