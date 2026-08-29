-- Partition lifecycle, append-only enforcement and DAG acyclicity.
-- Hand-written: none of this is expressible in the Drizzle DSL.
--
-- system-design §5: "`labs.submissions` and `contest.submissions` are
-- range-partitioned monthly; `progress.xp_events` weekly. Old partitions are
-- detached to S3 Parquet after 13 months."

CREATE SCHEMA IF NOT EXISTS "ops";
--> statement-breakpoint

-- Creates one range partition covering [from, to) if it does not already exist.
-- Returns the fully-qualified partition name.
CREATE OR REPLACE FUNCTION "ops"."ensure_range_partition"(
  p_schema text,
  p_table  text,
  p_suffix text,
  p_from   timestamptz,
  p_to     timestamptz
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_part text := p_table || '_' || p_suffix;
BEGIN
  IF to_regclass(format('%I.%I', p_schema, v_part)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      p_schema, v_part, p_schema, p_table, p_from, p_to
    );
  END IF;
  RETURN format('%s.%s', p_schema, v_part);
END;
$$;
--> statement-breakpoint

-- Monthly partitions for the two submission tables.
CREATE OR REPLACE FUNCTION "ops"."ensure_month_partition"(
  p_schema text,
  p_table  text,
  p_month  date
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_from timestamptz := date_trunc('month', p_month::timestamptz);
BEGIN
  RETURN "ops"."ensure_range_partition"(
    p_schema,
    p_table,
    to_char(v_from, 'YYYYMM'),
    v_from,
    v_from + interval '1 month'
  );
END;
$$;
--> statement-breakpoint

-- Weekly (ISO, Monday-anchored) partitions for progress.xp_events.
CREATE OR REPLACE FUNCTION "ops"."ensure_week_partition"(
  p_schema text,
  p_table  text,
  p_day    date
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_from timestamptz := date_trunc('week', p_day::timestamptz);
BEGIN
  RETURN "ops"."ensure_range_partition"(
    p_schema,
    p_table,
    to_char(v_from, 'IYYY"w"IW'),
    v_from,
    v_from + interval '1 week'
  );
END;
$$;
--> statement-breakpoint

-- Idempotent roll-forward, called at boot and nightly by the maintenance queue.
-- Keeps `p_months_ahead` monthly and `p_weeks_ahead` weekly partitions in front
-- of "now" so a write can never land on the default partition unexpectedly.
CREATE OR REPLACE FUNCTION "ops"."ensure_partitions_ahead"(
  p_months_ahead int DEFAULT 3,
  p_weeks_ahead  int DEFAULT 6
) RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  i int;
  v_created int := 0;
BEGIN
  FOR i IN -1..p_months_ahead LOOP
    PERFORM "ops"."ensure_month_partition"('labs', 'submissions', (current_date + (i || ' month')::interval)::date);
    PERFORM "ops"."ensure_month_partition"('contest', 'submissions', (current_date + (i || ' month')::interval)::date);
    v_created := v_created + 2;
  END LOOP;

  FOR i IN -1..p_weeks_ahead LOOP
    PERFORM "ops"."ensure_week_partition"('progress', 'xp_events', (current_date + (i || ' week')::interval)::date);
    v_created := v_created + 1;
  END LOOP;

  RETURN v_created;
END;
$$;
--> statement-breakpoint

-- Detaches partitions whose upper bound is older than p_months months. The
-- detached table is left in place for the export job to copy to S3 Parquet and
-- drop; detaching concurrently keeps the parent writable throughout.
CREATE OR REPLACE FUNCTION "ops"."detach_partitions_older_than"(
  p_schema text,
  p_table  text,
  p_months int DEFAULT 13
) RETURNS SETOF text
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_cutoff timestamptz := date_trunc('month', now()) - (p_months || ' month')::interval;
  v_upper timestamptz;
BEGIN
  FOR r IN
    SELECT c.relname AS part
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE pn.nspname = p_schema AND p.relname = p_table AND n.nspname = p_schema
  LOOP
    BEGIN
      SELECT (regexp_match(
                pg_get_expr(c.relpartbound, c.oid),
                'TO \(''([^'']+)''\)'))[1]::timestamptz
        INTO v_upper
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = p_schema AND c.relname = r.part;
    EXCEPTION WHEN others THEN
      CONTINUE; -- DEFAULT partition has no FROM/TO bound; never detach it.
    END;

    IF v_upper IS NOT NULL AND v_upper <= v_cutoff THEN
      EXECUTE format('ALTER TABLE %I.%I DETACH PARTITION %I.%I CONCURRENTLY',
                     p_schema, p_table, p_schema, r.part);
      RETURN NEXT format('%s.%s', p_schema, r.part);
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Catch-all partitions. A row that misses every range is a bug, but losing a
-- submission because a partition was missing would violate the 99.999%
-- durability SLO in §9, so it lands here and alerts instead.
CREATE TABLE IF NOT EXISTS "labs"."submissions_default"
  PARTITION OF "labs"."submissions" DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contest"."submissions_default"
  PARTITION OF "contest"."submissions" DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "progress"."xp_events_default"
  PARTITION OF "progress"."xp_events" DEFAULT;
--> statement-breakpoint

SELECT "ops"."ensure_partitions_ahead"(3, 6);
--> statement-breakpoint

-- billing.credit_ledger is append-only (§7). Enforced here rather than by
-- convention: a UPDATE or DELETE on the ledger would silently break the
-- self-audit that replays it against billing.credit_balances.
CREATE OR REPLACE FUNCTION "billing"."credit_ledger_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'billing.credit_ledger is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "credit_ledger_no_update"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "billing"."credit_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION "billing"."credit_ledger_append_only"();
--> statement-breakpoint

-- The lesson prerequisite graph must stay acyclic: the unlock recompute walks it
-- and the tutor recommends from it. Postgres has no declarative way to say this.
CREATE OR REPLACE FUNCTION "catalog"."lesson_prereqs_assert_acyclic"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cycle boolean;
BEGIN
  WITH RECURSIVE reachable(id) AS (
    SELECT NEW.lesson_id
    UNION
    SELECT lp.lesson_id
      FROM "catalog"."lesson_prereqs" lp
      JOIN reachable r ON lp.prereq_lesson_id = r.id
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE id = NEW.prereq_lesson_id)
    INTO v_cycle;

  IF v_cycle THEN
    RAISE EXCEPTION
      'lesson prerequisite edge %->% would create a cycle',
      NEW.prereq_lesson_id, NEW.lesson_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "lesson_prereqs_acyclic"
  AFTER INSERT OR UPDATE ON "catalog"."lesson_prereqs"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."lesson_prereqs_assert_acyclic"();
--> statement-breakpoint

-- Same argument for the concept DAG.
CREATE OR REPLACE FUNCTION "catalog"."concept_edges_assert_acyclic"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cycle boolean;
BEGIN
  IF NEW.kind <> 'prereq' THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE reachable(id) AS (
    SELECT NEW.to_concept_id
    UNION
    SELECT ce.to_concept_id
      FROM "catalog"."concept_edges" ce
      JOIN reachable r ON ce.from_concept_id = r.id
     WHERE ce.kind = 'prereq'
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE id = NEW.from_concept_id)
    INTO v_cycle;

  IF v_cycle THEN
    RAISE EXCEPTION
      'concept prerequisite edge %->% would create a cycle',
      NEW.from_concept_id, NEW.to_concept_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "concept_edges_acyclic"
  AFTER INSERT OR UPDATE ON "catalog"."concept_edges"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."concept_edges_assert_acyclic"();
